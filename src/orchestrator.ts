import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConflictRecord, GitMergeOperation, PendingUiRequest, Subtask, SwarmConfig, SwarmRun, VerificationResult, WorkerRuntime } from "./types.ts";
import { addUsage, emptyUsage, ensurePrivateDir, pathExists, truncateTail } from "./utils.ts";
import { RunStore } from "./state.ts";
import { WorkspaceManager } from "./workspace.ts";
import { writeGuardExtension } from "./guard-template.ts";
import { WorkerHandle, type WorkerHandleOptions } from "./worker.ts";
import { detectVerificationCommands, verificationFailurePrompt, verifyCommands } from "./verifier.ts";
import { validatePlan } from "./plan-validation.ts";
import { buildReport } from "./reporter.ts";
import { RepoLock } from "./repo-lock.ts";
import { processIdentityStatus, stopOwnedProcess } from "./process-identity.ts";

export interface OrchestratorHooks {
  projectTrusted: boolean;
  onUpdate(run: SwarmRun): void;
  onUi(workerId: string, request: PendingUiRequest & Record<string, unknown>): Promise<Record<string, unknown>>;
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
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistChain: Promise<void> = Promise.resolve();
  private interactionChain: Promise<void> = Promise.resolve();
  private abortRequested = false;
  private pauseRequested = false;
  private interruptRequested = false;
  private startedAt = Date.now();
  private finalVerification?: VerificationResult;
  private landingNote?: string;

  constructor(options: OrchestratorOptions) {
    this.run = options.run;
    this.config = options.config;
    this.store = options.store;
    this.workspace = options.workspace;
    this.agentDir = options.agentDir;
    this.hooks = options.hooks;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new WorkerHandle(workerOptions));
    this.repoLock = options.repoLock;
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
    this.startedAt = this.run.createdAt;
    try {
      if (this.run.git) {
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
      for (const wave of validation.waves) {
        await this.controlCheckpoint();
        if (this.abortRequested) break;
        const order = new Map(this.run.plan.mergeOrder.map((id, index) => [id, index]));
        const tasks = this.run.plan.subtasks
          .filter((task) => wave.includes(task.id) && !this.run.merged.includes(task.id))
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        if (tasks.length) await this.ensureCandidate("wave", `wave:${wave.join(",")}:${this.run.merged.length}`);
        for (let offset = 0; offset < tasks.length; offset += this.config.worker.maxConcurrency) {
          await this.controlCheckpoint();
          const batch = tasks.slice(offset, offset + this.config.worker.maxConcurrency);
          const prepared = (await Promise.all(batch.map((task) => this.runWorkerTask(task)))).filter((item): item is PreparedWorker => Boolean(item));
          await this.controlCheckpoint();
          prepared.sort((a, b) => (order.get(a.task.id) ?? 0) - (order.get(b.task.id) ?? 0));
          for (const item of prepared) await this.mergePrepared(item);
        }
        const candidate = this.activeOperation();
        const unresolvedCandidate = tasks.filter((task) => !candidate?.subtaskIds.includes(task.id));
        if (unresolvedCandidate.length) throw new Error(`wave 候选未完成: ${unresolvedCandidate.map((task) => `${task.id}:${this.run.workers[task.id]?.status ?? "missing"}`).join(", ")}`);
        await this.verifyIntegration(false);
        await this.promoteActiveCandidate();
        const unresolved = tasks.filter((task) => !this.run.merged.includes(task.id));
        if (unresolved.length) throw new Error(`wave 未推进: ${unresolved.map((task) => task.id).join(", ")}`);
      }
      if (this.abortRequested) {
        this.run.phase = "aborted";
        this.run.outcome = "aborted";
        return;
      }
      await this.controlCheckpoint();
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
      await this.workspace.cleanupWorktrees(landing.outcome === "branch");
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
    this.interruptRequested = true;
    this.run.phase = "interrupted";
    this.interruptedTurns.add(id);
    this.abortVerifications();
    await this.stopAll();
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
    return `cd ${shellQuote(runtime.worktree)} && env PI_SWARM_WORKER=1 PI_SWARM_RUN_DIR=${shellQuote(this.run.runDir)} ${args.map(shellQuote).join(" ")}`;
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
    await this.persist();
    try {
      const skipInitialTurn = priorStatus === "detached" || priorStatus === "verifying" || priorStatus === "merging" || priorStatus === "done" || runtime.verification?.ok;
      if (!skipInitialTurn) {
        const worker = await ensureHandle();
        const prompt = existing
          ? "Resume this interrupted swarm task from the persisted session and worktree. Inspect current changes first, finish the mission, and end with an updated Completion Report."
          : this.workerBrief(task);
        await this.runControlledPrompt(worker, runtime, prompt, "working");
      }
      const commands = task.acceptance.commands.length
        ? task.acceptance.commands
        : this.config.run.verify.worker ?? await detectVerificationCommands(workspace.path, false);
      for (let attempt = runtime.retries; attempt <= this.config.worker.maxRetries; attempt++) {
        runtime.status = "verifying";
        runtime.currentAction = "running worker verification";
        const verification = await this.verifyControlled(task.id, commands, workspace.path, runtime);
        runtime.verification = verification;
        if (verification.ok) break;
        if (verification.commands.some((command) => command.blocked)) throw new Error(`${task.id} 验证命令被安全策略拒绝: ${verification.commands.find((command) => command.blocked)?.stderr}`);
        if (attempt >= this.config.worker.maxRetries) throw new Error(`${task.id} 验证失败`);
        runtime.retries++;
        const worker = await ensureHandle();
        await this.runControlledPrompt(worker, runtime, verificationFailurePrompt(verification, runtime.retries, this.config.worker.maxRetries), "fixing");
      }
      if (!runtime.verification?.ok) throw new Error(`${task.id} 验证未通过`);
      await this.controlCheckpoint(runtime);
      await this.workspace.commitTask(task, workspace.path);
      await handle?.stop();
      return { task, runtime, handle };
    } catch (error) {
      if (error instanceof ControlFlowError || ["detached", "killed"].includes(runtime.status) || this.abortRequested || this.interruptRequested) {
        await handle?.stop().catch(() => undefined);
        await this.persist();
        return undefined;
      }
      runtime.status = "failed";
      runtime.currentAction = error instanceof Error ? error.message : String(error);
      runtime.endedAt = Date.now();
      await handle?.stop().catch(() => undefined);
      await this.persist();
      return undefined;
    } finally {
      this.handles.delete(task.id);
    }
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
      const controller = new AbortController();
      this.verificationControllers.set(key, controller);
      const result = await verifyCommands(commands, cwd, this.config.run.verifyTimeoutSec, {
        signal: controller.signal,
        allowedPrefixes: this.config.run.verifyAllowedPrefixes,
      });
      this.verificationControllers.delete(key);
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
    const result = await this.workspace.mergeTask(item.task, item.runtime.branch, operation);
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
    const commands = full
      ? this.config.run.verify.full ?? await detectVerificationCommands(target, true)
      : this.config.run.verify.integrationLight ?? await detectVerificationCommands(target, false);
    if (!commands.length) {
      const result = { ok: true, commands: [] };
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
    const guardPath = await writeGuardExtension({ runDir: this.run.runDir, worktree: targetWorktree, heartbeatFile: join(this.run.runDir, "heartbeat"), task, trusted: this.hooks.projectTrusted, config: this.config });
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
    handle.on("action", ({ label }) => { runtime.currentAction = label; runtime.lastEventAt = Date.now(); runtime.stallCount = 0; if (label.startsWith("⚠")) runtime.scopeViolations.push(label); this.schedulePersist(); });
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
    handle.on("ui", ({ request }) => { void this.enqueueInteraction(async () => this.routeUi(handle, runtime, request)); });
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

  private async routeUi(handle: WorkerHandle, runtime: WorkerRuntime, request: PendingUiRequest & Record<string, unknown>): Promise<void> {
    const dialog = ["select", "confirm", "input", "editor"].includes(request.method);
    if (!dialog) return;
    const previous = runtime.status;
    runtime.status = "awaiting";
    runtime.pendingUi.push(request);
    await this.persist();
    let response: Record<string, unknown>;
    if (this.config.approvalPolicy === "autoDeny") response = { id: request.id, cancelled: true };
    else if (this.config.approvalPolicy === "autoAllow") response = request.method === "confirm" ? { id: request.id, confirmed: true } : { id: request.id, value: request.options?.[0] ?? "" };
    else response = await this.hooks.onUi(runtime.subtaskId, request);
    try { handle.respondUi(response); } catch { /* Worker may have been paused or stopped while awaiting UI. */ }
    runtime.pendingUi = runtime.pendingUi.filter((item) => item.id !== request.id);
    if (runtime.status === "awaiting" && !runtime.pendingUi.length && !this.budgetBlocked.has(runtime.subtaskId)) runtime.status = previous;
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
    return `You are agent ${task.role} in a swarm working on: ${this.run.plan!.taskSummary}.\n\nMISSION\n${task.goal}\n\nCONTRACTS\n${contracts.map((contract) => `${contract.id}: ${contract.definition}`).join("\n") || "None"}\n\nSCOPE\nOwned: ${task.ownedPaths.join(", ")}\nRead context: ${task.readPaths.join(", ")}\nDo not modify other paths. Git commits and pushes are owned by the orchestrator.\n\nUPSTREAM\n${upstream || "None"}\n\nACCEPTANCE\n${task.acceptance.commands.join("\n")}\n${task.acceptance.criteria.join("\n")}\n\nWork autonomously. Finish with ## Completion Report containing what changed, files changed, verification, and follow-ups.`;
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
  }

  private async checkStalls(): Promise<void> {
    const now = Date.now();
    for (const [id, handle] of this.handles) {
      const runtime = this.runtimes.get(id) ?? this.run.workers[id];
      if (!runtime || !["working", "fixing"].includes(runtime.status) || now - runtime.lastEventAt < this.config.worker.stallSec * 1000) continue;
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
    this.heartbeatTimer = undefined;
    this.stallTimer = undefined;
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
}

function extractCompletionReport(text: string): string {
  const index = text.lastIndexOf("## Completion Report");
  return index === -1 ? truncateTail(text, 2_000) : text.slice(index, index + 4_000);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
