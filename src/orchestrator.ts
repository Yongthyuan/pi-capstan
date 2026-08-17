import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConflictRecord, GitMergeOperation, PendingUiRequest, Subtask, SwarmConfig, SwarmRun, VerificationResult, WorkerRuntime } from "./types.ts";
import { addUsage, emptyUsage, ensurePrivateDir, pathExists, truncateTail } from "./utils.ts";
import { RunStore } from "./state.ts";
import { WorkspaceManager } from "./workspace.ts";
import { writeGuardExtension } from "./guard-template.ts";
import { WorkerHandle, type WorkerHandleOptions } from "./worker.ts";
import { resolveVerifyCommands, skippedVerification, verificationFailurePrompt, verifyCommands } from "./verifier.ts";
import { validatePlan } from "./plan-validation.ts";
import { buildReport } from "./reporter.ts";
import { RepoLock } from "./repo-lock.ts";
import { processIdentityStatus, stopOwnedProcess } from "./process-identity.ts";
import { MetricsCollector } from "./metrics.ts";
import { loadConfiguredPlugins } from "./plugin-loader.ts";
import type { DefaultPluginRegistry } from "./plugins/registry.ts";

export interface OrchestratorHooks {
  projectTrusted: boolean;
  onUpdate(run: SwarmRun): void;
  onUi(workerId: string, request: PendingUiRequest & Record<string, unknown>): Promise<Record<string, unknown>>;
  onUiBatch?(requests: Array<{ workerId: string; request: PendingUiRequest & Record<string, unknown> }>): Promise<Record<string, Record<string, unknown>>>;
  onLeadMessage?(workerId: string, message: string): Promise<void> | void;
  onBudget(workerId: string, message: string): Promise<"extend" | "stop">;
  onBeforeReport?(run: SwarmRun): Promise<void> | void;
  onReport(run: SwarmRun, report: string): Promise<void> | void;
}

export interface OrchestratorOptions {
  run: SwarmRun;
  config: SwarmConfig;
  store: RunStore;
  workspace: WorkspaceManager;
  agentDir: string;
  hooks: OrchestratorHooks;
  workerFactory?: (options: WorkerHandleOptions) => WorkerHandle;
  repoLock?: RepoLock;
}

interface PreparedWorker {
  task: Subtask;
  runtime: WorkerRuntime;
  handle?: WorkerHandle;
}

interface QueuedUiRequest {
  handle: WorkerHandle;
  runtime: WorkerRuntime;
  request: PendingUiRequest & Record<string, unknown>;
}

class ControlFlowError extends Error {}

export class Orchestrator {
  readonly run: SwarmRun;
  readonly config: SwarmConfig;
  readonly store: RunStore;
  readonly workspace: WorkspaceManager;
  readonly agentDir: string;
  readonly hooks: OrchestratorHooks;
  private readonly workerFactory: (options: WorkerHandleOptions) => WorkerHandle;
  private readonly repoLock?: RepoLock;
  private readonly handles = new Map<string, WorkerHandle>();
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly verificationControllers = new Map<string, AbortController>();
  private readonly budgetBlocked = new Set<string>();
  private readonly interruptedTurns = new Set<string>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stallTimer?: ReturnType<typeof setInterval>;
  private mailboxTimer?: ReturnType<typeof setInterval>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistChain: Promise<void> = Promise.resolve();
  private mergeChain: Promise<void> = Promise.resolve();
  private interactionChain: Promise<void> = Promise.resolve();
  private setupChain: Promise<void> = Promise.resolve();
  private uiBatch: QueuedUiRequest[] = [];
  private uiBatchTimer?: ReturnType<typeof setTimeout>;
  private abortRequested = false;
  private pauseRequested = false;
  private interruptRequested = false;
  private startedAt = Date.now();
  private finalVerification?: VerificationResult;
  private landingNote?: string;
  readonly metrics: MetricsCollector;
  private plugins?: DefaultPluginRegistry;
  private effectiveConcurrency: number;

  constructor(options: OrchestratorOptions) {
    this.run = options.run;
    this.config = options.config;
    this.store = options.store;
    this.workspace = options.workspace;
    this.agentDir = options.agentDir;
    this.hooks = options.hooks;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new WorkerHandle(workerOptions));
    this.repoLock = options.repoLock;
    this.metrics = new MetricsCollector(this.run.runId, join(this.run.runDir, "metrics.jsonl"));
    this.effectiveConcurrency = this.config.worker.maxConcurrency;
    this.run.effectiveBudget ??= {
      workerBudgetUsd: this.config.worker.perAgentBudgetUsd,
      workerTokenLimit: this.config.worker.perAgentTokenLimit,
      runBudgetUsd: this.config.run.budgetUsd,
      runTokenLimit: this.config.run.tokenLimit,
    };
    this.applyEffectiveBudget();
  }

  async execute(allowDirtySnapshot = false): Promise<void> {
    if (!this.run.plan) {
      await this.repoLock?.release();
      throw new Error("run 没有计划");
    }
    const validation = validatePlan(this.run.plan, this.config.planner.maxSubtasks);
    if (!validation.ok) {
      await this.repoLock?.release();
      throw new Error(`计划无效: ${validation.errors.join("; ")}`);
    }
    this.run.error = undefined;
    this.run.outcome = undefined;
    this.run.partialSuccess = false;
    this.startedAt = this.run.createdAt;
    try {
      this.plugins = await loadConfiguredPlugins(this.config, { repoRoot: this.run.cwd, runDir: this.run.runDir, runId: this.run.runId });
      await this.applySchedulingStrategy();
      if (this.run.git) {
        for (const runtime of Object.values(this.run.workers)) {
          if (["failed", "blocked", "detached"].includes(runtime.status)) runtime.status = "pending";
          runtime.blockedBy = undefined;
        }
        this.workspace.restore(this.run.git);
        await this.workspace.ensureIntegrationWorktree();
        await this.workspace.reconcileOperation(this.run);
        await this.workspace.reconcileMerged(this.run);
        await this.cleanupOrphanWorkers();
      } else {
        this.run.git = await this.workspace.prepare(allowDirtySnapshot);
      }
      await this.startMonitors();
      this.run.phase = "executing";
      await this.persist();
      await this.executePlanDynamically();
      if (this.abortRequested) {
        this.run.phase = "aborted";
        this.run.outcome = "aborted";
        return;
      }
      await this.controlCheckpoint();
      const incomplete = this.run.plan.subtasks.filter((task) => !this.run.merged.includes(task.id));
      this.run.partialSuccess = this.run.merged.length > 0 && incomplete.length > 0;
      if (!this.run.merged.length && incomplete.length) throw new Error(`没有子任务通过验证；失败/阻塞: ${incomplete.map((task) => `${task.id}:${this.run.workers[task.id]?.status ?? "pending"}`).join(", ")}`);
      this.run.phase = "finalizing";
      await this.persist();
      await this.verifyIntegration(true);
      if (this.activeOperation()) await this.promoteActiveCandidate();
      await this.controlCheckpoint();
      const landing = await this.workspace.land(this.config.run.mergeStrategy);
      this.run.outcome = landing.outcome;
      this.landingNote = landing.note;
      this.run.phase = "reporting";
      await this.persist();
      this.run.phase = "done";
      this.run.totals.wallSec = Math.max(0, (Date.now() - this.startedAt) / 1000);
      const detachedPaths = Object.values(this.run.workers).filter((worker) => worker.status === "detached").map((worker) => worker.worktree).filter(Boolean);
      await this.workspace.cleanupWorktrees(landing.outcome === "branch" || Boolean(this.run.partialSuccess), detachedPaths);
    } catch (error) {
      if (this.interruptRequested || this.run.phase === "interrupted") {
        this.run.phase = "interrupted";
        this.run.outcome = undefined;
      } else if (this.abortRequested || this.run.phase === "aborted") {
        this.run.phase = "aborted";
        this.run.outcome = "aborted";
      } else {
        const operation = this.activeOperation();
        if (operation) await this.workspace.discardCandidate(operation).catch(() => undefined);
        this.run.phase = "failed";
        this.run.outcome = "failed";
        this.run.error = error instanceof Error ? error.message : String(error);
      }
      await this.stopAll();
    } finally {
      try {
        this.stopMonitors();
        await this.flushScheduledPersist();
        await this.persist();
        if (["done", "failed", "aborted"].includes(this.run.phase)) {
          await this.hooks.onBeforeReport?.(this.run);
          const report = buildReport(this.run, this.finalVerification, this.landingNote);
          const reportPath = join(this.run.runDir, "report.md");
          await writeFile(reportPath, report, { mode: 0o600 });
          this.run.reportPath = reportPath;
          await this.persist();
          await this.hooks.onReport(this.run, report);
        }
      } finally {
        await this.plugins?.cleanup().catch(() => undefined);
        await this.repoLock?.release();
      }
    }
  }

  async pause(): Promise<void> {
    this.pauseRequested = true;
    for (const [id, handle] of this.handles) {
      const runtime = this.runtimes.get(id) ?? this.run.workers[id];
      if (runtime && ["working", "fixing"].includes(runtime.status)) this.interruptedTurns.add(id);
      if (runtime && ["working", "fixing", "verifying"].includes(runtime.status)) runtime.status = "paused";
      await handle.abort();
    }
    this.abortVerifications();
    await this.persist();
  }

  async resume(): Promise<void> {
    this.pauseRequested = false;
    for (const runtime of Object.values(this.run.workers)) if (runtime.status === "paused") runtime.status = "pending";
    await this.persist();
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    this.run.phase = "aborted";
    this.run.outcome = "aborted";
    this.abortVerifications();
    await this.stopAll();
    await this.persist();
  }

  async interrupt(): Promise<void> {
    if (["done", "failed", "aborted"].includes(this.run.phase)) return;
    this.interruptRequested = true;
    this.run.phase = "interrupted";
    this.abortVerifications();
    await this.stopAll();
    await this.persist();
  }

  async killWorker(id: string): Promise<void> {
    const runtime = this.run.workers[id];
    if (!runtime) return;
    runtime.status = "killed";
    runtime.currentAction = "killed by user";
    this.interruptedTurns.add(id);
    this.verificationControllers.get(id)?.abort();
    await this.handles.get(id)?.stop();
    await this.persist();
  }

  async steerWorker(id: string, message: string): Promise<void> {
    const handle = this.handles.get(id);
    const runtime = this.run.workers[id];
    if (!handle || !runtime || !["working", "fixing"].includes(runtime.status)) throw new Error(`worker ${id} 当前不在可注入的模型回合`);
    await handle.steer(message);
  }

  async detachWorker(id: string): Promise<string | undefined> {
    const runtime = this.run.workers[id];
    if (!runtime) return undefined;
    runtime.status = "detached";
    runtime.currentAction = "manual takeover";
    this.interruptedTurns.add(id);
    this.verificationControllers.get(id)?.abort();
    await this.handles.get(id)?.stop();
    await this.persist();
    const launch = runtime.launch;
    if (!launch) throw new Error(`worker ${id} 缺少持久化启动清单，拒绝生成不受保护的接管命令`);
    const args = ["pi", "--no-extensions"];
    if (runtime.sessionFile) args.push("--session", runtime.sessionFile);
    else args.push("--name", `swarm/${id} manual takeover`);
    if (launch.model) args.push("--model", launch.model);
    if (launch.tools.length) args.push("--tools", launch.tools.join(","));
    args.push("--append-system-prompt", launch.promptPath);
    if (launch.safetyGuardPath) args.push("-e", launch.safetyGuardPath);
    args.push("-e", launch.guardPath, launch.projectTrusted ? "--approve" : "--no-approve");
    return buildManualTakeoverCommand(runtime.worktree, this.run.runDir, args);
  }

  async replacePlan(plan: SwarmRun["plan"]): Promise<void> {
    if (!plan) throw new Error("新计划为空");
    const validation = validatePlan(plan, this.config.planner.maxSubtasks);
    if (!validation.ok) throw new Error(`新计划无效: ${validation.errors.join("; ")}`);
    const previous = this.run.plan;
    if (!previous) throw new Error("当前 run 没有计划");
    for (const runtime of Object.values(this.run.workers)) {
      if (!runtime.startedAt && !this.run.merged.includes(runtime.subtaskId)) continue;
      const before = previous.subtasks.find((task) => task.id === runtime.subtaskId);
      const after = plan.subtasks.find((task) => task.id === runtime.subtaskId);
      if (!before || !after) throw new Error(`已启动任务 ${runtime.subtaskId} 不能在重规划中删除`);
      if (JSON.stringify(stableTaskShape(before)) !== JSON.stringify(stableTaskShape(after))) {
        throw new Error(`已启动任务 ${runtime.subtaskId} 的目标、依赖或作用域不能在重规划中修改`);
      }
    }
    this.run.plan = plan;
    this.run.planRevision = (this.run.planRevision ?? 1) + 1;
    this.run.planEdits.push(`runtime replan revision ${this.run.planRevision}`);
    await this.persist();
  }

  private async executePlanDynamically(): Promise<void> {
    while (!this.abortRequested) {
      await this.controlCheckpoint();
      const plan = this.run.plan!;
      const validation = validatePlan(plan, this.config.planner.maxSubtasks);
      if (!validation.ok) throw new Error(`运行中计划无效: ${validation.errors.join("; ")}`);
      const order = new Map(plan.mergeOrder.map((id, index) => [id, index]));
      const remaining = plan.subtasks
        .filter((task) => !this.run.merged.includes(task.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      if (!remaining.length) return;
      const runnable = remaining.filter((task) => {
        const status = this.run.workers[task.id]?.status;
        return task.dependsOn.every((id) => this.run.merged.includes(id)) && !["failed", "detached", "killed"].includes(status ?? "pending");
      });
      if (!runnable.length) {
        for (const task of remaining) {
          const runtime = this.run.workers[task.id];
          if (["failed", "detached", "killed"].includes(runtime?.status ?? "")) continue;
          this.markBlocked(task, task.dependsOn.filter((id) => !this.run.merged.includes(id)));
        }
        await this.persist();
        return;
      }
      await this.ensureCandidate("wave", `ready:${runnable.map((task) => task.id).join(",")}:${this.run.merged.length}:r${this.run.planRevision ?? 1}`);
      await this.runTaskPool(runnable);
      await this.mergeChain;
      const failed = runnable.filter((task) => this.run.workers[task.id]?.status === "failed");
      if (failed.length && this.config.run.failurePolicy === "fail-fast") throw new Error(`worker 失败: ${failed.map((task) => task.id).join(", ")}`);
      const candidate = this.activeOperation();
      if (!candidate) continue;
      if (!candidate.subtaskIds.length) {
        await this.workspace.discardCandidate(candidate);
        continue;
      }
      try {
        await this.verifyIntegration(false);
        await this.promoteActiveCandidate();
      } catch (error) {
        if (this.config.run.failurePolicy === "fail-fast") throw error;
        const affected = [...candidate.subtaskIds];
        await this.workspace.discardCandidate(candidate).catch(() => undefined);
        for (const id of affected) {
          const runtime = this.run.workers[id];
          if (runtime) runtime.status = "failed", (runtime.currentAction = `integration rejected: ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.persist();
      }
    }
  }

  private async runWorkerTask(task: Subtask): Promise<PreparedWorker | undefined> {
    await this.controlCheckpoint();
    const existing = this.run.workers[task.id];
    const priorStatus = existing?.status;
    const workspace = await this.workspace.createTaskWorktree(task);
    const runtime = existing ?? (this.run.workers[task.id] = {
      subtaskId: task.id,
      status: "spawning",
      worktree: workspace.path,
      branch: workspace.branch,
      currentAction: "starting",
      usage: emptyUsage(),
      turns: 0,
      retries: 0,
      pendingUi: [],
      lastEventAt: Date.now(),
      scopeViolations: [],
      stallCount: 0,
    });
    runtime.worktree = workspace.path;
    runtime.branch = workspace.branch;
    runtime.pendingUi ??= [];
    runtime.scopeViolations ??= [];
    runtime.stallCount ??= 0;
    runtime.activeTools ??= 0;
    runtime.revertedScopePaths ??= [];
    let handle: WorkerHandle | undefined;
    const ensureHandle = async (): Promise<WorkerHandle> => {
      if (handle?.running) return handle;
      const promptDir = join(this.run.runDir, "prompts");
      await ensurePrivateDir(promptDir);
      const promptPath = join(promptDir, `${task.id}.md`);
      await writeFile(promptPath, task.rolePrompt, { mode: 0o600 });
      const guardPath = await writeGuardExtension({
        runDir: this.run.runDir,
        worktree: workspace.path,
        heartbeatFile: join(this.run.runDir, "heartbeat"),
        task,
        trusted: this.hooks.projectTrusted,
        config: this.config,
        peers: [...(this.run.plan?.subtasks.map((peer) => peer.id).filter((id) => id !== task.id) ?? []), "lead"],
      });
      const safetyGuardPath = await this.resolveSafetyGuard();
      runtime.launch = {
        guardPath,
        promptPath,
        sessionDir: join(this.run.runDir, "sessions", task.id),
        model: task.model ?? this.config.worker.model,
        tools: [...this.config.worker.tools],
        projectTrusted: this.hooks.projectTrusted,
        safetyGuardPath,
      };
      handle = this.workerFactory({
        id: task.id,
        title: task.title,
        worktree: workspace.path,
        runDir: this.run.runDir,
        guardPath,
        promptPath,
        sessionDir: join(this.run.runDir, "sessions", task.id),
        sessionFile: runtime.sessionFile,
        model: task.model ?? this.config.worker.model,
        tools: this.config.worker.tools,
        projectTrusted: this.hooks.projectTrusted,
        safetyGuardPath,
      });
      this.handles.set(task.id, handle);
      this.bindWorker(handle, runtime);
      return handle;
    };

    runtime.startedAt ??= Date.now();
    await this.metrics.recordWorkerStart(task.id, task.id);
    await this.persist();
    try {
      runtime.currentAction = "preparing worktree dependencies";
      const linked = await this.runExclusiveSetup(async () => {
        const linkedDirs = await this.workspace.prepareTaskDependencies(workspace.path, this.config.worker.shareDependencyDirs);
        if (!runtime.setupComplete && this.config.worker.setupCommands.length) {
          if (!this.hooks.projectTrusted) throw new Error(`${task.id} setupCommands 仅允许在受信任项目中执行`);
          const setup = await verifyCommands(this.config.worker.setupCommands, workspace.path, this.config.worker.setupTimeoutSec, {
            allowedPrefixes: this.config.run.setupAllowedPrefixes,
          });
          if (!setup.ok) {
            const failed = setup.commands.find((command) => command.exitCode !== 0);
            throw new Error(`${task.id} worktree setup 失败: ${failed?.stderr || failed?.stdout || failed?.command || "unknown"}`);
          }
        }
        return linkedDirs;
      });
      runtime.setupComplete = true;
      if (linked.length) runtime.currentAction = `shared dependencies: ${linked.join(", ")}`;
      await this.persist();
      const skipInitialTurn = priorStatus === "detached" || priorStatus === "verifying" || priorStatus === "merging" || priorStatus === "done" || runtime.verification?.ok;
      if (!skipInitialTurn) {
        const worker = await ensureHandle();
        const prompt = existing
          ? "Resume this interrupted swarm task from the persisted session and worktree. Inspect current changes first, finish the mission, and end with an updated Completion Report."
          : this.workerBrief(task);
        await this.runControlledPrompt(worker, runtime, prompt, "working");
      }
      const commands = await resolveVerifyCommands({
        configured: this.config.run.verify.worker,
        cwd: workspace.path,
        full: false,
        fallback: task.acceptance.commands,
      });
      for (let attempt = runtime.retries; attempt <= this.config.worker.maxRetries; attempt++) {
        runtime.status = "verifying";
        runtime.currentAction = "running worker verification";
        const verification = await this.verifyControlled(task.id, commands, workspace.path, runtime);
        runtime.verification = verification;
        if (verification.ok || verification.skipped) break;
        if (verification.commands.some((command) => command.blocked)) throw new Error(`${task.id} 验证命令被安全策略拒绝: ${verification.commands.find((command) => command.blocked)?.stderr}`);
        if (attempt >= this.config.worker.maxRetries) throw new Error(`${task.id} 验证失败`);
        runtime.retries++;
        const failed = verification.commands.find((command) => command.exitCode !== 0);
        const strategy = this.plugins?.get("verification", "configured");
        let prompt = verificationFailurePrompt(verification, runtime.retries, this.config.worker.maxRetries);
        if (strategy?.classifyFailure && failed) {
          const classified = await strategy.classifyFailure(task, {
            exitCode: failed.exitCode,
            stdout: failed.stdout,
            stderr: failed.stderr,
          }, runtime.retries);
          if (!classified.shouldRetry) throw new Error(`${task.id} 验证失败（插件判定不再重试: ${classified.category}）`);
          if (classified.retryWithModifications?.additionalContext) {
            prompt += `\nAdditional context from verifier: ${classified.retryWithModifications.additionalContext}`;
          }
        }
        const worker = await ensureHandle();
        await this.runControlledPrompt(worker, runtime, prompt, "fixing");
      }
      if (!runtime.verification?.ok) throw new Error(`${task.id} 验证未通过`);
      await this.controlCheckpoint(runtime);
      const committed = await this.workspace.commitTask(task, workspace.path, {
        allowlist: this.config.worker.scopeAllowlist,
        violationPolicy: this.config.worker.scopeViolationPolicy,
        ephemeralPaths: this.config.worker.shareDependencyDirs,
      });
      if (committed.reverted.length) {
        runtime.revertedScopePaths = Array.from(new Set([...(runtime.revertedScopePaths ?? []), ...committed.reverted]));
        runtime.scopeViolations.push(`reverted out-of-scope changes: ${committed.reverted.join(", ")}`);
        runtime.currentAction = `reverted ${committed.reverted.length} out-of-scope path(s)`;
        const postScopeVerification = await this.verifyControlled(task.id, commands, workspace.path, runtime);
        runtime.verification = postScopeVerification;
        if (!postScopeVerification.ok) throw new Error(`${task.id} 越界文件回滚后验证失败`);
      }
      await handle?.stop();
      await this.metrics.recordWorkerEnd(task.id, "completed", runtime.usage.cost, runtime.retries);
      return { task, runtime, handle };
    } catch (error) {
      if (error instanceof ControlFlowError || ["detached", "killed"].includes(runtime.status) || this.abortRequested || this.interruptRequested) {
        await handle?.stop().catch(() => undefined);
        await this.metrics.recordWorkerEnd(task.id, "aborted", runtime.usage.cost, runtime.retries).catch(() => undefined);
        await this.persist();
        return undefined;
      }
      runtime.status = "failed";
      runtime.currentAction = error instanceof Error ? error.message : String(error);
      runtime.endedAt = Date.now();
      await handle?.stop().catch(() => undefined);
      await this.metrics.recordWorkerEnd(task.id, "failed", runtime.usage.cost, runtime.retries).catch(() => undefined);
      await this.persist();
      return undefined;
    } finally {
      this.handles.delete(task.id);
    }
  }

  private async runTaskPool(tasks: Subtask[]): Promise<void> {
    const descriptors = tasks.flatMap((task) => this.config.worker.bestOfN === 1
      ? [{ parent: task, attempt: task }]
      : Array.from({ length: this.config.worker.bestOfN }, (_, index) => ({
          parent: task,
          attempt: { ...task, id: attemptId(task.id, index + 1), title: `${task.title} · candidate ${index + 1}` },
        })));
    const remaining = new Map(tasks.map((task) => [task.id, this.config.worker.bestOfN]));
    const preparedByTask = new Map<string, PreparedWorker[]>();
    const selectionPromises: Promise<void>[] = [];
    let cursor = 0;
    const runSlot = async () => {
      while (true) {
        const index = cursor++;
        const descriptor = descriptors[index];
        if (!descriptor) return;
        await this.controlCheckpoint();
        const prepared = await this.runWorkerTask(descriptor.attempt);
        if (prepared) {
          const group = preparedByTask.get(descriptor.parent.id) ?? [];
          group.push(prepared);
          preparedByTask.set(descriptor.parent.id, group);
        }
        const count = (remaining.get(descriptor.parent.id) ?? 1) - 1;
        remaining.set(descriptor.parent.id, count);
        if (count === 0) {
          selectionPromises.push(this.finalizeAttempts(descriptor.parent, descriptors.filter((item) => item.parent.id === descriptor.parent.id).map((item) => item.attempt), preparedByTask.get(descriptor.parent.id) ?? []));
        }
      }
    };
    const slots = Math.min(this.effectiveConcurrency, descriptors.length);
    await Promise.all(Array.from({ length: slots }, () => runSlot()));
    await Promise.all(selectionPromises);
  }

  private async finalizeAttempts(parent: Subtask, attempts: Subtask[], prepared: PreparedWorker[]): Promise<void> {
    if (attempts.length === 1) {
      if (prepared[0]) await this.mergePreparedSafely(prepared[0]);
      return;
    }
    const runtimes = attempts.map((attempt) => this.run.workers[attempt.id]).filter((runtime): runtime is WorkerRuntime => Boolean(runtime));
    const summaries = runtimes.map((runtime) => ({
      id: runtime.subtaskId,
      status: runtime.status,
      branch: runtime.branch,
      retries: runtime.retries,
      cost: runtime.usage.cost,
      verificationOk: Boolean(runtime.verification?.ok),
    }));
    if (!prepared.length) {
      const representative = runtimes.sort(compareAttemptRuntime)[0];
      if (representative) {
        for (const attempt of attempts) delete this.run.workers[attempt.id], this.runtimes.delete(attempt.id);
        representative.subtaskId = parent.id;
        representative.status = "failed";
        representative.competition = { winner: summaries[0]?.id ?? attempts[0]!.id, attempts: summaries };
        this.run.workers[parent.id] = representative;
      }
      await this.persist();
      return;
    }
    const winner = await this.selectBestAttempt(parent, prepared);
    for (const item of prepared) {
      if (item === winner) continue;
      await this.workspace.discardTaskWorktree(item.runtime.worktree, item.runtime.branch).catch(() => undefined);
    }
    for (const attempt of attempts) delete this.run.workers[attempt.id], this.runtimes.delete(attempt.id);
    winner.runtime.subtaskId = parent.id;
    winner.runtime.competition = { winner: winner.task.id, attempts: summaries };
    this.run.workers[parent.id] = winner.runtime;
    winner.task = parent;
    await this.persist();
    await this.mergePreparedSafely(winner);
  }

  private async selectBestAttempt(parent: Subtask, prepared: PreparedWorker[]): Promise<PreparedWorker> {
    if (this.config.worker.bestOfNJudge && prepared.length > 1) {
      const judgeTask: Subtask = {
        id: `judge-${attemptId(parent.id, Date.now())}`.slice(0, 64),
        title: `select best candidate for ${parent.id}`,
        goal: "Select the strongest verified implementation without modifying files.",
        role: "candidate-reviewer",
        rolePrompt: "You are a read-only candidate reviewer. Inspect candidate branch diffs and return exactly WINNER: <candidate-id> plus a short reason.",
        ownedPaths: [], readPaths: ["**"], dependsOn: [], contracts: parent.contracts,
        acceptance: { commands: [], criteria: ["One verified candidate is selected"] },
        model: parent.model,
      };
      const handle = await this.createIntegrationWorker(judgeTask, parent.model);
      const operation = this.activeOperation();
      if (operation) {
        const runtime = this.syntheticRuntime(judgeTask, operation.candidateWorktree, operation.candidateBranch);
        try {
          const choices = prepared.map((item) => `- ${item.task.id}: branch=${item.runtime.branch}; retries=${item.runtime.retries}; cost=$${item.runtime.usage.cost.toFixed(4)}; inspect with git diff ${operation.preMergeSha}...${item.runtime.branch}`).join("\n");
          await this.runControlledPrompt(handle, runtime, `Choose the best implementation for task ${parent.id}. All candidates passed acceptance. Compare correctness, scope discipline, maintainability, and diff minimality.\n${choices}\nReturn WINNER: <candidate-id>. Do not edit files.`, "working");
          const selected = prepared.find((item) => new RegExp(`WINNER\\s*:\\s*${escapeRegExp(item.task.id)}\\b`, "i").test(runtime.lastText ?? ""));
          if (selected) return selected;
        } catch { /* Deterministic fallback below. */ }
        finally {
          await handle.stop().catch(() => undefined);
          this.handles.delete(judgeTask.id);
        }
      }
    }
    return [...prepared].sort((a, b) => compareAttemptRuntime(a.runtime, b.runtime))[0]!;
  }

  private async mergePreparedSafely(prepared: PreparedWorker): Promise<void> {
    try {
      await this.enqueueMerge(prepared);
    } catch (error) {
      prepared.runtime.status = "failed";
      prepared.runtime.currentAction = error instanceof Error ? error.message : String(error);
      prepared.runtime.endedAt = Date.now();
      await this.persist();
      if (this.config.run.failurePolicy === "fail-fast") throw error;
    }
  }

  private enqueueMerge(item: PreparedWorker): Promise<void> {
    const next = this.mergeChain.then(() => this.mergePrepared(item), () => this.mergePrepared(item));
    this.mergeChain = next.catch(() => undefined);
    return next;
  }

  private markBlocked(task: Subtask, blockedBy: string[]): void {
    const runtime = this.run.workers[task.id] ?? (this.run.workers[task.id] = {
      subtaskId: task.id,
      status: "blocked",
      worktree: "",
      branch: `swarm/${this.run.runId}/${task.id}`,
      currentAction: "blocked by failed dependency",
      usage: emptyUsage(),
      turns: 0,
      retries: 0,
      pendingUi: [],
      lastEventAt: Date.now(),
      scopeViolations: [],
    });
    runtime.status = "blocked";
    runtime.blockedBy = blockedBy;
    runtime.currentAction = `blocked by: ${blockedBy.join(", ")}`;
  }

  private async runControlledPrompt(handle: WorkerHandle, runtime: WorkerRuntime, firstPrompt: string, activeStatus: "working" | "fixing"): Promise<void> {
    let prompt = firstPrompt;
    while (true) {
      await this.controlCheckpoint(runtime);
      runtime.status = activeStatus;
      runtime.currentAction = activeStatus === "working" ? "agent turn" : "fixing verification failure";
      runtime.lastEventAt = Date.now();
      await this.persist();
      try {
        await handle.prompt(prompt, this.config.worker.wallClockMin * 60_000);
      } catch (error) {
        if (this.shouldStop(runtime)) throw new ControlFlowError("worker turn interrupted");
        throw error;
      }
      if (!this.interruptedTurns.delete(runtime.subtaskId)) return;
      await this.controlCheckpoint(runtime);
      prompt = "Continue from the interrupted turn. Inspect the current worktree and session state first; do not repeat completed work.";
    }
  }

  private async verifyControlled(key: string, commands: string[], cwd: string, runtime?: WorkerRuntime): Promise<VerificationResult> {
    while (true) {
      await this.controlCheckpoint(runtime);
      if (!commands.length) return skippedVerification();
      const controller = new AbortController();
      this.verificationControllers.set(key, controller);
      const started = Date.now();
      const strategy = this.plugins?.get("verification", "configured");
      const task = this.run.plan?.subtasks.find((item) => item.id === key || key.startsWith(item.id));
      let selected = commands;
      if (strategy?.selectCommands && task) {
        const changes = await this.workspace.listUncommittedChanges(cwd);
        const chosen = await strategy.selectCommands(task, cwd, changes);
        if (chosen) selected = chosen;
      }
      let result: VerificationResult;
      if (!selected.length) {
        result = skippedVerification();
      } else {
        result = await verifyCommands(selected, cwd, this.config.run.verifyTimeoutSec, {
          signal: controller.signal,
          allowedPrefixes: this.config.run.verifyAllowedPrefixes,
        });
      }
      this.verificationControllers.delete(key);
      await this.metrics.recordVerification(key, result.ok, Date.now() - started).catch(() => undefined);
      if (this.shouldStop(runtime)) throw new ControlFlowError("verification interrupted");
      if (this.pauseRequested || result.commands.some((command) => command.aborted)) {
        await this.controlCheckpoint(runtime);
        continue;
      }
      return result;
    }
  }

  private async mergePrepared(item: PreparedWorker): Promise<void> {
    const operation = this.activeOperation();
    if (!operation) throw new Error("缺少活跃 candidate operation");
    await this.controlCheckpoint(item.runtime);
    item.runtime.status = "merging";
    item.runtime.currentAction = "merging into verified candidate";
    operation.pendingSubtaskId = item.task.id;
    operation.phase = "merging";
    operation.updatedAt = Date.now();
    await this.persist();
    const mergeStarted = Date.now();
    const result = await this.workspace.mergeTask(item.task, item.runtime.branch, operation);
    await this.metrics.recordMergeAttempt(item.task.id, result.ok, result.ok ? 0 : result.conflicts.length, Date.now() - mergeStarted).catch(() => undefined);
    await this.controlCheckpoint(item.runtime);
    if (!result.ok) {
      const conflict: ConflictRecord = { incomingSubtask: item.task.id, files: result.conflicts, resolved: false };
      this.run.conflicts.push(conflict);
      try {
        await this.runArbiter(item.task, result.conflicts);
        conflict.resolved = true;
      } catch (error) {
        conflict.note = error instanceof Error ? error.message : String(error);
        await this.workspace.abortMerge(operation);
        item.runtime.status = "failed";
        throw error;
      }
    }
    item.runtime.status = "merging";
    item.runtime.currentAction = "candidate ready; awaiting integration verification";
    await this.persist();
  }

  private async runArbiter(task: Subtask, files: string[]): Promise<void> {
    if (!files.length) throw new Error("merge 失败但没有可识别冲突文件");
    const arbiterTask: Subtask = {
      id: `arbiter-${task.id}`,
      title: `resolve ${task.id} merge conflicts`,
      goal: "Resolve merge conflicts without changing unrelated behavior.",
      role: "merge-arbiter",
      rolePrompt: "You are a merge arbiter. Resolve only the listed conflict files. Do not commit or change unrelated files.",
      ownedPaths: files,
      readPaths: files,
      dependsOn: [],
      contracts: task.contracts,
      acceptance: { commands: [], criteria: ["No conflict markers remain"] },
      model: task.model,
    };
    const operation = this.activeOperation();
    if (!operation) throw new Error("冲突仲裁缺少 candidate operation");
    const handle = await this.createIntegrationWorker(arbiterTask, task.model);
    try {
      await this.runControlledPrompt(handle, this.syntheticRuntime(arbiterTask, operation.candidateWorktree, operation.candidateBranch), `A merge produced conflicts in:\n${files.join("\n")}\nResolve all conflict markers so both the existing integration branch and incoming task ${task.id} goals are preserved. Do not commit.`, "fixing");
      await this.workspace.finishConflictMerge(`resolve merge conflicts for ${task.id}`, operation);
    } finally {
      await handle.stop().catch(() => undefined);
      this.handles.delete(arbiterTask.id);
    }
  }

  private async verifyIntegration(full: boolean): Promise<void> {
    let operation = this.activeOperation();
    let target = operation?.candidateWorktree ?? this.run.git!.integrationWorktree;
    await this.prepareVerificationEnvironment(target, operation);
    const commands = await resolveVerifyCommands({
      configured: full ? this.config.run.verify.full : this.config.run.verify.integrationLight,
      cwd: target,
      full,
    });
    if (!commands.length) {
      const result = skippedVerification();
      if (full) this.finalVerification = result;
      if (operation) {
        operation.verification = result;
        operation.phase = "verified";
        operation.updatedAt = Date.now();
        await this.persist();
      }
      return;
    }
    let result = await this.verifyControlled(full ? "integration-full" : "integration-light", commands, target);
    if (result.commands.some((command) => command.blocked)) throw new Error(`集成验证命令被安全策略拒绝: ${result.commands.find((command) => command.blocked)?.stderr}`);
    if (!result.ok) {
      if (!operation) {
        operation = await this.ensureCandidate("repair", `repair:${Date.now()}`);
        target = operation.candidateWorktree;
        await this.prepareVerificationEnvironment(target, operation);
      }
      await this.runIntegrationFixer(commands, result);
      result = await this.verifyControlled(full ? "integration-full" : "integration-light", commands, target);
    }
    if (full) this.finalVerification = result;
    if (!result.ok) throw new Error(`集成验证失败: ${truncateTail(JSON.stringify(result), 4_000)}`);
    if (operation) {
      operation.verification = result;
      operation.phase = "verified";
      operation.candidateSha = await this.workspace.commitIntegration("swarm: persist verified candidate", operation) ?? operation.candidateSha;
      operation.updatedAt = Date.now();
      await this.persist();
    }
  }

  private prepareVerificationEnvironment(target: string, operation?: GitMergeOperation): Promise<void> {
    return this.runExclusiveSetup(async () => {
      await this.workspace.prepareTaskDependencies(target, this.config.worker.shareDependencyDirs);
      const setupComplete = operation ? operation.setupComplete : this.run.integrationSetupComplete;
      if (!setupComplete && this.config.worker.setupCommands.length) {
        if (!this.hooks.projectTrusted) throw new Error("integration setupCommands 仅允许在受信任项目中执行");
        const setup = await verifyCommands(this.config.worker.setupCommands, target, this.config.worker.setupTimeoutSec, { allowedPrefixes: this.config.run.setupAllowedPrefixes });
        if (!setup.ok) {
          const failed = setup.commands.find((command) => command.exitCode !== 0);
          throw new Error(`integration setup 失败: ${failed?.stderr || failed?.stdout || failed?.command || "unknown"}`);
        }
        if (operation) operation.setupComplete = true;
        else this.run.integrationSetupComplete = true;
        await this.persist();
      }
    });
  }

  private runExclusiveSetup<T>(action: () => Promise<T>): Promise<T> {
    // Shared dependency dirs are symlinks onto one physical directory, so
    // concurrent setup commands (npm ci and friends) would trample each other.
    const result = this.setupChain.then(action, action);
    this.setupChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runIntegrationFixer(commands: string[], failure: VerificationResult): Promise<void> {
    const task: Subtask = {
      id: `integration-fixer-${Date.now().toString(36)}`,
      title: "integration verification fixer",
      goal: "Fix integration verification failures with the smallest evidence-grounded change.",
      role: "integration-fixer",
      rolePrompt: "You are the integration fixer. Work in the integration tree, make only necessary changes, and do not commit.",
      ownedPaths: ["**"],
      readPaths: ["**"],
      dependsOn: [],
      contracts: [],
      acceptance: { commands, criteria: ["All integration verification commands pass"] },
      model: this.config.worker.model ?? undefined,
    };
    const handle = await this.createIntegrationWorker(task, task.model);
    const operation = this.activeOperation();
    if (!operation) throw new Error("integration fixer 缺少 candidate operation");
    const runtime = this.syntheticRuntime(task, operation.candidateWorktree, operation.candidateBranch);
    try {
      await this.runControlledPrompt(handle, runtime, verificationFailurePrompt(failure, 1, 1), "fixing");
      await this.workspace.commitIntegration("swarm: fix integration verification", this.activeOperation());
    } finally {
      await handle.stop().catch(() => undefined);
      this.handles.delete(task.id);
    }
  }

  private async createIntegrationWorker(task: Subtask, model?: string): Promise<WorkerHandle> {
    const operation = this.activeOperation();
    const targetWorktree = operation?.candidateWorktree ?? this.run.git!.integrationWorktree;
    const promptDir = join(this.run.runDir, "prompts");
    await ensurePrivateDir(promptDir);
    const promptPath = join(promptDir, `${task.id}.md`);
    await writeFile(promptPath, task.rolePrompt, { mode: 0o600 });
    const guardPath = await writeGuardExtension({ runDir: this.run.runDir, worktree: targetWorktree, heartbeatFile: join(this.run.runDir, "heartbeat"), task, trusted: this.hooks.projectTrusted, config: this.config, peers: [] });
    const handle = this.workerFactory({ id: task.id, title: task.title, worktree: targetWorktree, runDir: this.run.runDir, guardPath, promptPath, sessionDir: join(this.run.runDir, "sessions", task.id), model: model ?? this.config.worker.model, tools: this.config.worker.tools, projectTrusted: this.hooks.projectTrusted, safetyGuardPath: await this.resolveSafetyGuard() });
    this.handles.set(task.id, handle);
    return handle;
  }

  private syntheticRuntime(task: Subtask, worktree: string, branch: string): WorkerRuntime {
    const runtime: WorkerRuntime = { subtaskId: task.id, status: "working", worktree, branch, currentAction: "starting", usage: emptyUsage(), turns: 0, retries: 0, pendingUi: [], lastEventAt: Date.now(), scopeViolations: [], stallCount: 0 };
    this.bindWorker(this.handles.get(task.id)!, runtime);
    return runtime;
  }

  private activeOperation(): GitMergeOperation | undefined {
    return [...(this.run.gitOperations ?? [])].reverse().find((item) => !["promoted", "discarded"].includes(item.phase));
  }

  private async ensureCandidate(kind: GitMergeOperation["kind"], label: string): Promise<GitMergeOperation> {
    const active = this.activeOperation();
    if (active) {
      await this.workspace.ensureCandidateWorktree(active);
      return active;
    }
    const operation = await this.workspace.beginCandidate(kind, `${this.run.runId}:${label}`);
    this.run.gitOperations ??= [];
    this.run.gitOperations.push(operation);
    await this.persist();
    return operation;
  }

  private async promoteActiveCandidate(): Promise<void> {
    const operation = this.activeOperation();
    if (!operation) return;
    if (operation.phase !== "verified") throw new Error(`candidate ${operation.operationId} 尚未验证`);
    await this.workspace.promoteCandidate(operation);
    const order = new Map(this.run.plan?.mergeOrder.map((id, index) => [id, index]) ?? []);
    for (const id of [...operation.subtaskIds].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))) {
      if (!this.run.merged.includes(id)) this.run.merged.push(id);
      const runtime = this.run.workers[id];
      if (runtime) {
        runtime.status = "done";
        runtime.currentAction = "promoted after candidate verification";
        runtime.endedAt = Date.now();
      }
    }
    this.run.merged.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
    await this.persist();
  }

  private async cleanupOrphanWorkers(): Promise<void> {
    for (const runtime of Object.values(this.run.workers)) {
      if (!runtime.pid) continue;
      const status = await processIdentityStatus(runtime.pid, runtime.pidMarker);
      if (status === "unknown" || (!runtime.pidMarker && status === "match")) {
        throw new Error(`无法验证旧 worker PID ${runtime.pid} 的启动身份；请先手动确认该进程已停止`);
      }
      if (status === "match" && runtime.pidMarker) {
        await stopOwnedProcess(runtime.pid, runtime.pidMarker);
        runtime.currentAction = "stale worker stopped before recovery";
      }
      runtime.pid = undefined;
      runtime.pidMarker = undefined;
      runtime.pidStartedAt = undefined;
    }
  }

  private applyEffectiveBudget(): void {
    const budget = this.run.effectiveBudget!;
    this.config.worker.perAgentBudgetUsd = budget.workerBudgetUsd;
    this.config.worker.perAgentTokenLimit = budget.workerTokenLimit;
    this.config.run.budgetUsd = budget.runBudgetUsd;
    this.config.run.tokenLimit = budget.runTokenLimit;
  }

  private bindWorker(handle: WorkerHandle, runtime: WorkerRuntime): void {
    this.runtimes.set(runtime.subtaskId, runtime);
    const usageBase = { ...runtime.usage };
    const turnsBase = runtime.turns;
    handle.on("state", (state) => { runtime.sessionFile = state.sessionFile; runtime.pid = handle.pid; runtime.pidStartedAt = Date.now(); runtime.pidMarker = state.pidMarker; this.schedulePersist(); });
    handle.on("tool", ({ active, reset }) => {
      runtime.activeTools = reset ? 0 : Math.max(0, (runtime.activeTools ?? 0) + (active ? 1 : -1));
      runtime.activeToolStartedAt = runtime.activeTools > 0 ? runtime.activeToolStartedAt ?? Date.now() : undefined;
      runtime.lastEventAt = Date.now();
      runtime.stallCount = 0;
      this.schedulePersist();
    });
    handle.on("action", ({ label }) => { runtime.currentAction = label; runtime.lastEventAt = Date.now(); runtime.stallCount = 0; if (label.startsWith("⚠")) runtime.scopeViolations.push(label); this.schedulePersist(); });
    // Streaming deltas arrive per token; refresh liveness in memory only.
    handle.on("activity", () => { runtime.lastEventAt = Date.now(); runtime.stallCount = 0; });
    handle.on("text", ({ text }) => { runtime.lastText = truncateTail(text, 8_000); runtime.completionReport = extractCompletionReport(text); runtime.lastEventAt = Date.now(); runtime.stallCount = 0; this.schedulePersist(); });
    handle.on("usage", ({ usage, turns }) => {
      runtime.usage = addUsage({ ...usageBase }, usage);
      runtime.turns = turnsBase + turns;
      runtime.lastEventAt = Date.now();
      runtime.stallCount = 0;
      this.recomputeTotals();
      if (this.isOverBudget(runtime) && !this.budgetBlocked.has(runtime.subtaskId)) {
        this.budgetBlocked.add(runtime.subtaskId);
        this.interruptedTurns.add(runtime.subtaskId);
        runtime.status = "awaiting";
        runtime.currentAction = "budget limit reached";
        void handle.abort();
        void this.enqueueInteraction(async () => this.resolveBudget(runtime));
      }
      this.schedulePersist();
    });
    handle.on("retrying", ({ attempt, maxAttempts }) => { runtime.currentAction = `rate-limit retry ${attempt}/${maxAttempts}`; runtime.lastEventAt = Date.now(); this.schedulePersist(); });
    handle.on("ui", ({ request }) => { void this.queueUi(handle, runtime, request); });
    handle.on("exit", ({ code, stderr }) => { if (!["done", "failed", "killed", "detached"].includes(runtime.status) && code !== 0) runtime.currentAction = `worker exit ${code}: ${truncateTail(stderr, 500)}`; this.schedulePersist(); });
  }

  private async resolveBudget(runtime: WorkerRuntime): Promise<void> {
    if (!this.isOverBudget(runtime)) {
      this.budgetBlocked.delete(runtime.subtaskId);
      runtime.status = "pending";
      return;
    }
    const workerTokens = runtime.usage.input + runtime.usage.output;
    const runTokens = this.run.totals.input + this.run.totals.output;
    const message = `worker=${runtime.subtaskId} cost=$${runtime.usage.cost.toFixed(3)}/${this.config.worker.perAgentBudgetUsd.toFixed(3)}, tokens=${workerTokens}/${this.config.worker.perAgentTokenLimit}; run=$${this.run.totals.cost.toFixed(3)}/${this.config.run.budgetUsd.toFixed(3)}, tokens=${runTokens}/${this.config.run.tokenLimit}`;
    let choice: "extend" | "stop" = "stop";
    try { choice = await this.hooks.onBudget(runtime.subtaskId, message); } catch { choice = "stop"; }
    if (this.interruptRequested || this.abortRequested) {
      this.budgetBlocked.delete(runtime.subtaskId);
      return;
    }
    if (choice === "extend") {
      this.config.worker.perAgentBudgetUsd = Math.max(this.config.worker.perAgentBudgetUsd * 1.25, runtime.usage.cost + 0.25);
      this.config.worker.perAgentTokenLimit = Math.ceil(Math.max(this.config.worker.perAgentTokenLimit * 1.25, workerTokens + 10_000));
      this.config.run.budgetUsd = Math.max(this.config.run.budgetUsd * 1.25, this.run.totals.cost + 0.5);
      this.config.run.tokenLimit = Math.ceil(Math.max(this.config.run.tokenLimit * 1.25, runTokens + 20_000));
      this.run.effectiveBudget = {
        workerBudgetUsd: this.config.worker.perAgentBudgetUsd,
        workerTokenLimit: this.config.worker.perAgentTokenLimit,
        runBudgetUsd: this.config.run.budgetUsd,
        runTokenLimit: this.config.run.tokenLimit,
      };
      this.budgetBlocked.delete(runtime.subtaskId);
      runtime.status = "pending";
      runtime.currentAction = "budget extended; waiting to continue";
      await this.persist();
      return;
    }
    this.budgetBlocked.delete(runtime.subtaskId);
    this.abortRequested = true;
    this.run.phase = "aborted";
    this.run.outcome = "aborted";
    runtime.status = "killed";
    runtime.currentAction = "stopped at budget gate";
    this.abortVerifications();
    await this.stopAll();
    await this.persist();
  }

  private async queueUi(handle: WorkerHandle, runtime: WorkerRuntime, request: PendingUiRequest & Record<string, unknown>): Promise<void> {
    const dialog = ["select", "confirm", "input", "editor"].includes(request.method);
    if (!dialog) return;
    const previous = runtime.status;
    runtime.status = "awaiting";
    runtime.pendingUi.push(request);
    await this.persist();
    this.uiBatch.push({ handle, runtime, request: { ...request, _previousStatus: previous } });
    if (this.uiBatchTimer) return;
    this.uiBatchTimer = setTimeout(() => {
      this.uiBatchTimer = undefined;
      void this.enqueueInteraction(() => this.flushUiBatch());
    }, this.config.ui.approvalBatchMs);
    this.uiBatchTimer.unref();
  }

  private async flushUiBatch(): Promise<void> {
    const batch = this.uiBatch.splice(0);
    if (!batch.length) return;
    let responses: Record<string, Record<string, unknown>> = {};
    if (this.config.approvalPolicy === "route" && batch.length > 1 && this.hooks.onUiBatch) {
      try { responses = await this.hooks.onUiBatch(batch.map((item) => ({ workerId: item.runtime.subtaskId, request: item.request }))); }
      catch { responses = {}; }
    }
    for (const item of batch) {
      const { handle, runtime, request } = item;
      let response = responses[uiResponseKey(runtime.subtaskId, request.id)] ?? responses[request.id];
      if (!response) {
        if (this.config.approvalPolicy === "autoDeny") response = { id: request.id, cancelled: true };
        else if (this.config.approvalPolicy === "autoAllow") response = autoAllowUi(request);
        else {
          try { response = await this.hooks.onUi(runtime.subtaskId, request); }
          catch { response = { id: request.id, cancelled: true }; }
        }
      }
      try { handle.respondUi(response); } catch { /* Worker may have been paused or stopped while awaiting UI. */ }
      runtime.pendingUi = runtime.pendingUi.filter((pending) => pending.id !== request.id);
      const previous = String((request as any)._previousStatus ?? "working") as WorkerRuntime["status"];
      if (runtime.status === "awaiting" && !runtime.pendingUi.length && !this.budgetBlocked.has(runtime.subtaskId)) runtime.status = previous;
    }
    await this.persist();
  }

  private enqueueInteraction(task: () => Promise<void>): Promise<void> {
    const result = this.interactionChain.then(task, task);
    this.interactionChain = result.catch(() => undefined);
    return result;
  }

  private isOverBudget(runtime: WorkerRuntime): boolean {
    const workerTokens = runtime.usage.input + runtime.usage.output;
    const runTokens = this.run.totals.input + this.run.totals.output;
    return runtime.usage.cost > this.config.worker.perAgentBudgetUsd
      || workerTokens > this.config.worker.perAgentTokenLimit
      || this.run.totals.cost > this.config.run.budgetUsd
      || runTokens > this.config.run.tokenLimit;
  }

  private async controlCheckpoint(runtime?: WorkerRuntime): Promise<void> {
    while (this.pauseRequested && !this.abortRequested && !this.interruptRequested) {
      if (runtime && !["detached", "killed", "failed"].includes(runtime.status)) runtime.status = "paused";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    while (runtime && this.budgetBlocked.has(runtime.subtaskId) && !this.abortRequested && !this.interruptRequested) {
      runtime.status = "awaiting";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.shouldStop(runtime)) throw new ControlFlowError("run control requested stop");
  }

  private shouldStop(runtime?: WorkerRuntime): boolean {
    return this.abortRequested || this.interruptRequested || Boolean(runtime && ["detached", "killed", "failed"].includes(runtime.status));
  }

  private abortVerifications(): void {
    for (const controller of this.verificationControllers.values()) controller.abort();
  }

  private workerBrief(task: Subtask): string {
    const contracts = this.run.plan!.contracts.filter((contract) => task.contracts.includes(contract.id));
    const upstream = task.dependsOn.map((id) => this.run.workers[id]?.completionReport).filter(Boolean).join("\n\n");
    const peers = [...this.run.plan!.subtasks.filter((peer) => peer.id !== task.id).map((peer) => peer.id), "lead"];
    return `You are agent ${task.role} in a swarm working on: ${this.run.plan!.taskSummary}.\n\nMISSION\n${task.goal}\n\nCONTRACTS\n${contracts.map((contract) => `${contract.id}: ${contract.definition}`).join("\n") || "None"}\n\nSCOPE\nOwned: ${task.ownedPaths.join(", ")}\nShared metadata: ${[...(task.sharedPaths ?? []), ...this.config.worker.scopeAllowlist].join(", ") || "None"}\nGenerated: ${(task.generatedPaths ?? []).join(", ") || "None"}\nRead context: ${task.readPaths.join(", ")}\nDo not modify other paths. Git commits and pushes are owned by the orchestrator. Use write/edit for content and swarm_fs for mkdir, touch, copy, move, or delete; do not fight the bash guard.\n\nPEERS\n${peers.join(", ") || "None"}. Use swarm_send only for concrete interface/blocker coordination, and check swarm_inbox when coordination is expected.\n\nUPSTREAM\n${upstream || "None"}\n\nACCEPTANCE\n${task.acceptance.commands.join("\n")}\n${task.acceptance.criteria.join("\n")}\n\nWork autonomously. Finish with ## Completion Report containing what changed, files changed, verification, and follow-ups.`;
  }

  private async resolveSafetyGuard(): Promise<string | undefined> {
    const configured = this.config.safetyGuardPath ?? join(this.agentDir, "extensions", "safety-guard.ts");
    return await pathExists(configured) ? configured : undefined;
  }

  private recomputeTotals(): void {
    const totals = { ...emptyUsage(), turns: 0, wallSec: Math.max(0, (Date.now() - this.startedAt) / 1000) };
    if (this.run.planning) {
      addUsage(totals, this.run.planning.usage);
      totals.turns += this.run.planning.turns;
    }
    const workers = new Set<WorkerRuntime>([...Object.values(this.run.workers), ...this.runtimes.values()]);
    for (const worker of workers) {
      addUsage(totals, worker.usage);
      totals.turns += worker.turns;
    }
    this.run.totals = totals;
  }

  private async startMonitors(): Promise<void> {
    const path = join(this.run.runDir, "heartbeat");
    await ensurePrivateDir(this.run.runDir);
    const beat = () => void writeFile(path, String(Date.now()), { mode: 0o600 }).catch(() => undefined);
    beat();
    this.heartbeatTimer = setInterval(beat, 10_000);
    this.heartbeatTimer.unref();
    this.stallTimer = setInterval(() => void this.checkStalls(), Math.min(10_000, Math.max(1_000, this.config.worker.stallSec * 250)));
    this.stallTimer.unref();
    this.mailboxTimer = setInterval(() => void this.deliverMailboxMessages(), 1_000);
    this.mailboxTimer.unref();
  }

  private async deliverMailboxMessages(): Promise<void> {
    await this.deliverLeadMailbox();
    for (const [id, handle] of this.handles) {
      const runtime = this.runtimes.get(id) ?? this.run.workers[id];
      if (!runtime || !handle.running || !["working", "fixing"].includes(runtime.status)) continue;
      const path = join(this.run.runDir, "mailbox", `${id}.jsonl`);
      let raw: string;
      try { raw = await readFile(path, "utf8"); } catch { continue; }
      const offset = Math.min(runtime.mailboxOffset ?? 0, Buffer.byteLength(raw));
      const data = Buffer.from(raw).subarray(offset).toString("utf8");
      if (!data.trim()) continue;
      const messages: string[] = [];
      for (const line of data.trim().split("\n")) {
        try {
          const item = JSON.parse(line) as { from?: string; message?: string };
          if (item.from && item.message) messages.push(`[${item.from}] ${String(item.message).slice(0, 4_000)}`);
        } catch { /* Leave malformed mailbox data inspectable without injecting it. */ }
      }
      runtime.mailboxOffset = Buffer.byteLength(raw);
      if (messages.length) {
        runtime.currentAction = `received ${messages.length} peer message(s)`;
        runtime.lastEventAt = Date.now();
        await handle.steer(`SWARM MAILBOX\n${messages.join("\n\n")}\nAcknowledge or act only if relevant to your owned task.`).catch(() => undefined);
      }
      this.schedulePersist();
    }
  }

  private async deliverLeadMailbox(): Promise<void> {
    const path = join(this.run.runDir, "mailbox", "lead.jsonl");
    let raw: string;
    try { raw = await readFile(path, "utf8"); } catch { return; }
    const offset = Math.min(this.run.leadMailboxOffset ?? 0, Buffer.byteLength(raw));
    const data = Buffer.from(raw).subarray(offset).toString("utf8");
    if (!data.trim()) return;
    this.run.leadMailboxOffset = Buffer.byteLength(raw);
    for (const line of data.trim().split("\n")) {
      try {
        const item = JSON.parse(line) as { from?: string; message?: string };
        if (item.from && item.message) await this.hooks.onLeadMessage?.(item.from, String(item.message).slice(0, 4_000));
      } catch { /* Ignore malformed mailbox records. */ }
    }
    this.schedulePersist();
  }

  private async checkStalls(): Promise<void> {
    const now = Date.now();
    for (const [id, handle] of this.handles) {
      const runtime = this.runtimes.get(id) ?? this.run.workers[id];
      if (!runtime || !["working", "fixing"].includes(runtime.status) || (runtime.activeTools ?? 0) > 0 || now - runtime.lastEventAt < this.config.worker.stallSec * 1000) continue;
      if ((runtime.stallCount ?? 0) === 0) {
        runtime.stallCount = 1;
        runtime.lastEventAt = now;
        runtime.currentAction = "stall detected; steering once";
        await handle.steer("You appear stalled. Reassess the current state, choose the smallest next concrete action, and continue. If blocked, explain it in the Completion Report.").catch(() => undefined);
      } else {
        runtime.status = "failed";
        runtime.currentAction = `stalled twice (${this.config.worker.stallSec}s each)`;
        this.interruptedTurns.add(id);
        await handle.abort();
      }
      this.schedulePersist();
    }
  }

  private stopMonitors(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    if (this.mailboxTimer) clearInterval(this.mailboxTimer);
    this.heartbeatTimer = undefined;
    this.stallTimer = undefined;
    this.mailboxTimer = undefined;
    if (this.uiBatchTimer) clearTimeout(this.uiBatchTimer);
    this.uiBatchTimer = undefined;
  }

  private async stopAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.handles.values()).map((handle) => handle.stop()));
    this.handles.clear();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, this.config.ui.renderThrottleMs);
    this.persistTimer.unref();
  }

  private async flushScheduledPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persist();
    }
    await this.persistChain;
  }

  private persist(): Promise<void> {
    const operation = this.persistChain.then(() => this.persistNow(), () => this.persistNow());
    this.persistChain = operation.catch(() => undefined);
    return operation;
  }

  private async persistNow(): Promise<void> {
    this.recomputeTotals();
    await this.store.save(this.run);
    this.hooks.onUpdate(this.run);
  }

  private async applySchedulingStrategy(): Promise<void> {
    const strategy = this.plugins?.get("scheduling", "configured");
    if (!strategy || !this.run.plan) return;
    try {
      const schedule = await strategy.schedule(this.run.plan, {
        maxConcurrency: this.config.worker.maxConcurrency,
        remainingBudget: Math.max(0, this.config.run.budgetUsd - (this.run.totals.cost || 0)),
        completedTasks: [...this.run.merged],
      });
      if (schedule.batches?.length) {
        const suggested = Math.max(...schedule.batches.map((batch) => batch.length), 1);
        this.effectiveConcurrency = Math.max(1, Math.min(this.config.worker.maxConcurrency, suggested));
      }
      // `schedule().batches` is advisory width only. DAG order stays `dependsOn`.
      // Do not call `adjust()` here: metrics are not yet available.
    } catch (error) {
      // Plugin failures must not abort the run; fall back to configured concurrency.
      this.effectiveConcurrency = this.config.worker.maxConcurrency;
      this.run.error = undefined;
      void error;
    }
  }
}

function extractCompletionReport(text: string): string {
  const index = text.lastIndexOf("## Completion Report");
  return index === -1 ? truncateTail(text, 2_000) : text.slice(index, index + 4_000);
}

function stableTaskShape(task: Subtask): unknown {
  return {
    id: task.id,
    goal: task.goal,
    ownedPaths: task.ownedPaths,
    sharedPaths: task.sharedPaths ?? [],
    generatedPaths: task.generatedPaths ?? [],
    dependsOn: task.dependsOn,
    contracts: task.contracts,
  };
}

function autoAllowUi(request: PendingUiRequest): Record<string, unknown> {
  return request.method === "confirm"
    ? { id: request.id, confirmed: true }
    : { id: request.id, value: request.options?.[0] ?? request.prefill ?? "" };
}

function uiResponseKey(workerId: string, requestId: string): string {
  return `${workerId}:${requestId}`;
}

function attemptId(parentId: string, index: number): string {
  return `${parentId.slice(0, 46)}-try-${String(index)}`.slice(0, 64);
}

function compareAttemptRuntime(left: WorkerRuntime, right: WorkerRuntime): number {
  const leftVerified = left.verification?.ok ? 0 : 1;
  const rightVerified = right.verification?.ok ? 0 : 1;
  return leftVerified - rightVerified
    || (left.scopeViolations.length - right.scopeViolations.length)
    || (left.retries - right.retries)
    || (left.usage.cost - right.usage.cost)
    || left.subtaskId.localeCompare(right.subtaskId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildManualTakeoverCommand(worktree: string, runDir: string, args: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `Set-Location -LiteralPath ${powershellQuote(worktree)}; $env:PI_SWARM_WORKER='1'; $env:PI_SWARM_RUN_DIR=${powershellQuote(runDir)}; & ${args.map(powershellQuote).join(" ")}`;
  }
  return `cd ${shellQuote(worktree)} && env PI_SWARM_WORKER=1 PI_SWARM_RUN_DIR=${shellQuote(runDir)} ${args.map(shellQuote).join(" ")}`;
}
