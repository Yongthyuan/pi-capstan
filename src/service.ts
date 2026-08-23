import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParsedCapstanCommand, CapstanConfig, CapstanPlan, CapstanRun } from "./types.ts";
import { CaseStore } from "./cases.ts";
import { loadConfig } from "./config.ts";
import { decideGate } from "./gate.ts";
import { PiLlmClient } from "./llm.ts";
import { buildRepoBrief, createPlan, type RepoBrief } from "./planner.ts";
import { pruneRunArtifacts, RunStore } from "./state.ts";
import { WorkspaceManager } from "./workspace.ts";
import { Orchestrator } from "./orchestrator.ts";
import { DOCS_BASE_URL, addUsage, emptyUsage, ensurePrivateDir, makeRunId, pathExists, runCommand } from "./utils.ts";
import { reviewPlan } from "./ui/plan-panel.ts";
import { renderRunText, showDashboard, widgetLines } from "./ui/dashboard.ts";
import { RepoLock } from "./repo-lock.ts";
import { validatePlan } from "./plan-validation.ts";
import { validateConfig, formatValidationResult, autoFixConfig } from "./config-validator.ts";
import { RunAnalyzer } from "./analyzer.ts";
import { generateConfigFromAnswers, describeConfig, writeConfigWithComments, type WizardAnswers } from "./config-wizard.ts";

export class CapstanService {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly configDirName: string;
  activeRun?: CapstanRun;
  activeOrchestrator?: Orchestrator;
  private activeConfig?: CapstanConfig;

  constructor(pi: ExtensionAPI, agentDir: string, configDirName: string) {
    this.pi = pi;
    this.agentDir = agentDir;
    this.configDirName = configDirName;
  }

  async handle(parsed: ParsedCapstanCommand, ctx: ExtensionCommandContext): Promise<void> {
    for (const warning of parsed.warnings) ctx.ui.notify(warning, "warning");
    if (parsed.action === "run") return this.runTask(parsed.task, ctx, parsed);
    if (parsed.action === "board") return this.board(ctx);
    if (parsed.action === "pause") return this.pause(ctx);
    if (parsed.action === "resume") return this.resume(ctx, parsed.rest[0]);
    if (parsed.action === "abort") return this.abort(ctx);
    if (parsed.action === "status") return void ctx.ui.notify(renderRunText(this.activeRun), "info");
    if (parsed.action === "merge") return this.merge(ctx, parsed.rest[0]);
    if (parsed.action === "pr") return this.createPullRequest(ctx, parsed.rest[0]);
    if (parsed.action === "replan") return this.replan(ctx);
    if (parsed.action === "clean") return this.clean(ctx);
    if (parsed.action === "cases") return this.cases(ctx, parsed.rest);
    if (parsed.action === "replay") return this.replay(ctx, parsed.rest[0]);
    if (parsed.action === "config") return this.configure(ctx);
    if (parsed.action === "validate") return this.validateConfiguration(ctx);
    if (parsed.action === "analyze") return this.analyzeRuns(ctx, parsed.rest);
    return this.help(ctx);
  }

  async runTask(task: string, ctx: ExtensionContext, options: Partial<ParsedCapstanCommand> = {}): Promise<void> {
    if (this.activeRun && !["done", "failed", "aborted"].includes(this.activeRun.phase)) throw new Error(`已有活跃 run ${this.activeRun.runId}`);
    if (options.solo) {
      this.pi.sendUserMessage(task);
      return;
    }
    const detectedRepoRoot = await detectRepoRoot(ctx.cwd);
    const repoRoot = detectedRepoRoot ?? ctx.cwd;
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    await pruneRunArtifacts(join(repoRoot, this.configDirName, "capstan", "runs"), config.retention);
    const currentModel = (ctx as any).model as { provider?: string; id?: string } | undefined;
    if (!config.worker.model && currentModel?.provider && currentModel.id) config.worker.model = `${currentModel.provider}/${currentModel.id}`;
    if (options.max) config.worker.maxConcurrency = Math.max(1, Math.min(8, Math.trunc(options.max)));
    if (options.budget) config.run.budgetUsd = options.budget;
    if (options.bestOf) config.worker.bestOfN = Math.max(1, Math.min(8, Math.trunc(options.bestOf)));
    if (options.model) config.worker.model = options.model;
    this.activeConfig = config;
    const runId = makeRunId();
    const runsRoot = join(repoRoot, this.configDirName, "capstan", "runs");
    const runDir = join(runsRoot, runId);
    const store = new RunStore(runsRoot);
    const run = newRun(runId, runDir, repoRoot, task);
    run.planning = { startedAt: Date.now(), timeoutMs: config.planner.timeoutSec * 1_000, calls: 0, turns: 0, usage: emptyUsage() };
    run.effectiveBudget = {
      workerBudgetUsd: config.worker.perAgentBudgetUsd,
      workerTokenLimit: config.worker.perAgentTokenLimit,
      runBudgetUsd: config.run.budgetUsd,
      runTokenLimit: config.run.tokenLimit,
    };
    this.activeRun = run;
    let repoLock: RepoLock | undefined;
    let lockTransferred = false;
    try {
      if (detectedRepoRoot) {
        repoLock = await RepoLock.forRepo(repoRoot, runId);
        await repoLock.acquire();
        await addRunExclude(repoRoot, this.configDirName);
      }
      await store.save(run);
      this.pi.appendEntry("capstan-run", { runId, phase: run.phase, task, runDir });
      const brief = await buildRepoBrief(repoRoot, task, config.planner.repoMapTokens * 4);
      const llm = new PiLlmClient(ctx as any, config, async (usage) => {
        addUsage(run.planning!.usage, usage);
        run.planning!.calls++;
        run.planning!.turns++;
        addUsage(run.totals, usage);
        run.totals.turns++;
        await store.save(run);
        const tokens = run.planning!.usage.input + run.planning!.usage.output;
        if (run.planning!.usage.cost > config.planner.budgetUsd || tokens > config.planner.tokenLimit) {
          throw new Error(`planner 预算超限: $${run.planning!.usage.cost.toFixed(3)}/${config.planner.budgetUsd}, tokens=${tokens}/${config.planner.tokenLimit}`);
        }
      });
      const gate = options.force
        ? { decision: "complex" as const, score: 10, reason: "--force", ruleHits: ["forced"], modelUsed: false, estimatedSubtasks: 3 }
        : await decideGate(task, brief.fileCount, brief.summary, config.gate, llm);
      run.gate = gate;
      if (gate.decision === "simple") {
        run.planning.endedAt = Date.now();
        run.phase = "done";
        run.outcome = "planned";
        await store.save(run);
        ctx.ui.notify(`capstan: ${gate.reason}，已交回主会话`, "info");
        this.pi.sendUserMessage(task);
        return;
      }
      if (!detectedRepoRoot && !options.planOnly) {
        run.planning.endedAt = Date.now();
        run.phase = "done";
        run.outcome = "aborted";
        await store.save(run);
        ctx.ui.notify(
          "Capstan executes inside a Git repository — worktree isolation and recovery depend on it.\n" +
            "Fix: cd into your project or run `git init` first. (/capstan \"task\" --plan-only works anywhere)\n" +
            "Capstan 需要在 Git 仓库中执行；--plan-only 模式无此要求。",
          "warning",
        );
        return;
      }
      run.phase = "planning";
      await store.save(run);
      const caseStore = new CaseStore(join(this.agentDir, "capstan", "cases"), config.caseStore.max, config.caseStore.threshold, config.caseStore.matcher);
      const cases = config.caseStore.enabled ? await caseStore.match(task, brief) : [];
      const planned = await createPlan(task, brief, cases, llm, config);
      run.planning.endedAt = Date.now();
      if ("recommend" in planned) {
        run.phase = "done";
        run.outcome = "planned";
        await store.save(run);
        ctx.ui.notify(`planner 建议单 agent: ${planned.reason}`, "info");
        this.pi.sendUserMessage(task);
        return;
      }
      run.plan = planned;
      run.phase = "reviewing";
      await store.save(run);
      if (options.planOnly) {
        run.phase = "done";
        run.outcome = "planned";
        await store.save(run);
        this.pi.sendMessage({ customType: "capstan-report", content: `# Capstan Plan · ${planned.taskSummary}\n\n\`\`\`json\n${JSON.stringify(planned, null, 2)}\n\`\`\``, display: true, details: { runId, planOnly: true } }, { deliverAs: "nextTurn" });
        return;
      }
      const reviewed = await reviewPlan(ctx, planned, gate, config.planner.maxSubtasks);
      if (!reviewed.plan) {
        run.phase = "aborted";
        run.outcome = "aborted";
        await store.save(run);
        ctx.ui.notify("已取消 capstan", "info");
        return;
      }
      run.plan = reviewed.plan;
      run.planEdits = reviewed.edits;
      await store.save(run);
      let allowDirty = false;
      const status = await runCommand("git", ["status", "--porcelain=v1", "-uall"], { cwd: repoRoot });
      if (status.exitCode !== 0) throw new Error("执行模式要求 Git 仓库");
      if (status.stdout.trim()) {
        allowDirty = await ctx.ui.confirm("检测到脏工作区", "可以创建包含当前内容的临时基线，但结果只保留在 branch，不能自动 apply。继续？");
        if (!allowDirty) {
          run.phase = "aborted";
          run.outcome = "aborted";
          await store.save(run);
          return;
        }
        config.run.mergeStrategy = "branch";
      }
      const orchestrator = this.makeOrchestrator(run, config, store, brief, caseStore, ctx, repoLock);
      lockTransferred = Boolean(repoLock);
      this.activeOrchestrator = orchestrator;
      ctx.ui.notify(`capstan ${runId} 已启动；/capstan board 查看`, "info");
      void orchestrator.execute(allowDirty).finally(() => {
        if (this.activeRun?.runId === runId) this.activeOrchestrator = undefined;
      });
    } catch (error) {
      run.phase = "failed";
      run.outcome = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.planning!.endedAt ??= Date.now();
      await store.save(run).catch(() => undefined);
      throw error;
    } finally {
      if (!lockTransferred) await repoLock?.release();
    }
  }

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const store = new RunStore(join(repoRoot, this.configDirName, "capstan", "runs"));
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    await pruneRunArtifacts(store.runsRoot, config.retention);
    const unfinished = (await store.list()).filter((run) => !["done", "aborted", "failed"].includes(run.phase) || (run.phase === "done" && run.partialSuccess));
    if (store.diagnostics.length) ctx.ui.notify(`有 ${store.diagnostics.length} 个 capstan 状态损坏；请用运行目录中的 state.prev.json 排查`, "warning");
    if (unfinished.length) ctx.ui.notify(`发现 ${unfinished.length} 个未完成 capstan run；使用 /capstan resume`, "warning");
  }

  async onSessionShutdown(): Promise<void> {
    await this.activeOrchestrator?.interrupt();
  }

  private makeOrchestrator(run: CapstanRun, config: CapstanConfig, store: RunStore, brief: RepoBrief, caseStore: CaseStore, ctx: ExtensionContext, repoLock?: RepoLock): Orchestrator {
    const workspace = new WorkspaceManager({ cwd: run.cwd, runId: run.runId, runDir: run.runDir, worktreesRoot: join(this.agentDir, "capstan", "worktrees") });
    return new Orchestrator({
      run,
      config,
      store,
      workspace,
      agentDir: this.agentDir,
      repoLock,
      hooks: {
        projectTrusted: ctx.isProjectTrusted(),
        onUpdate: (updated) => {
          this.activeRun = updated;
          ctx.ui.setWidget("capstan", widgetLines(updated));
          ctx.ui.setStatus("capstan", renderRunText(updated));
        },
        onUi: (_workerId, request) => routeUi(ctx, request),
        onUiBatch: async (requests) => {
          const choice = await ctx.ui.select(
            `${requests.length} 个 worker 审批请求`,
            ["逐项处理", "全部拒绝", "全部允许"],
          );
          const responses: Record<string, Record<string, unknown>> = {};
          for (const { workerId, request } of requests) {
            const key = `${workerId}:${request.id}`;
            if (choice === "全部拒绝" || choice === undefined) responses[key] = { id: request.id, cancelled: true };
            else if (choice === "全部允许") responses[key] = request.method === "confirm" ? { id: request.id, confirmed: true } : { id: request.id, value: request.options?.[0] ?? request.prefill ?? "" };
            else responses[key] = await routeUi(ctx, request);
          }
          return responses;
        },
        onLeadMessage: (workerId, message) => {
          ctx.ui.notify(`Capstan 协调请求 · ${workerId}: ${message}\n如需调整计划，使用 /capstan replan。`, "warning");
        },
        onBudget: async (workerId, message) => {
          const choice = await ctx.ui.select(`Capstan 预算门 ${workerId}\n${message}`, ["增加 25% 并继续", "停止整个 run"]);
          return choice === "增加 25% 并继续" ? "extend" : "stop";
        },
        onBeforeReport: async (updated) => {
          if (config.caseStore.enabled) {
            const record = await caseStore.record(updated, brief);
            if (record) updated.caseId = record.id, await store.save(updated);
          }
        },
        onReport: async (updated, report) => {
          this.pi.sendMessage({ customType: "capstan-report", content: report, display: true, details: { runId: updated.runId, outcome: updated.outcome } }, { deliverAs: "nextTurn", triggerTurn: config.ui.reportTriggerTurn });
          this.pi.appendEntry("capstan-run", { runId: updated.runId, phase: updated.phase, outcome: updated.outcome, reportPath: updated.reportPath });
          ctx.ui.setWidget("capstan", undefined);
          ctx.ui.setStatus("capstan", undefined);
        },
      },
    });
  }

  private async board(ctx: ExtensionContext): Promise<void> {
    const action = await showDashboard(ctx, () => this.activeRun);
    if (action.type === "pause") await this.pause(ctx);
    else if (action.type === "resume") await this.resume(ctx);
    else if (action.type === "abort") await this.abort(ctx);
    else if (action.type === "kill" && action.workerId) await this.activeOrchestrator?.killWorker(action.workerId);
    else if (action.type === "steer" && action.workerId) {
      const message = await ctx.ui.input(`注入 ${action.workerId}`, "给该 worker 的指令");
      if (message) await this.activeOrchestrator?.steerWorker(action.workerId, message);
    } else if (action.type === "detach" && action.workerId) {
      const command = await this.activeOrchestrator?.detachWorker(action.workerId);
      if (command) {
        ctx.ui.setEditorText(command);
        ctx.ui.notify("接管命令已放入主编辑器", "info");
      }
    }
  }

  private async pause(ctx: ExtensionContext): Promise<void> {
    if (!this.activeOrchestrator) return void ctx.ui.notify("没有活跃 capstan", "warning");
    await this.activeOrchestrator.pause();
    ctx.ui.notify("capstan 已暂停", "info");
  }

  private async resume(ctx: ExtensionContext, runId?: string): Promise<void> {
    if (this.activeOrchestrator) {
      await this.activeOrchestrator.resume();
      ctx.ui.notify("capstan 已继续", "info");
      return;
    }
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const store = new RunStore(join(repoRoot, this.configDirName, "capstan", "runs"));
    const runs = (await store.list()).filter((run) => Boolean(run.plan) && run.phase !== "aborted" && (run.phase !== "done" || run.partialSuccess));
    if (!runs.length) return void ctx.ui.notify("没有可恢复 run", "info");
    const selectedId = runId ?? (runs.length === 1 ? runs[0]!.runId : await ctx.ui.select("选择 run", runs.map((item) => item.runId)));
    const chosen = runs.find((run) => run.runId === selectedId);
    if (!chosen?.plan) return;
    chosen.phase = "executing";
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    this.activeConfig = config;
    const brief = await buildRepoBrief(repoRoot, chosen.task, config.planner.repoMapTokens * 4);
    const caseStore = new CaseStore(join(this.agentDir, "capstan", "cases"), config.caseStore.max, config.caseStore.threshold, config.caseStore.matcher);
    const repoLock = await RepoLock.forRepo(repoRoot, chosen.runId);
    await repoLock.acquire();
    let orchestrator: Orchestrator;
    try {
      orchestrator = this.makeOrchestrator(chosen, config, store, brief, caseStore, ctx, repoLock);
    } catch (error) {
      await repoLock.release();
      throw error;
    }
    this.activeRun = chosen;
    this.activeOrchestrator = orchestrator;
    void orchestrator.execute(chosen.git?.dirtyBase ?? false).finally(() => { this.activeOrchestrator = undefined; });
  }

  private async abort(ctx: ExtensionContext): Promise<void> {
    if (!this.activeOrchestrator) return void ctx.ui.notify("没有活跃 capstan", "warning");
    if (await ctx.ui.confirm("终止 capstan", "停止所有 worker 并保留排障数据？")) await this.activeOrchestrator.abort();
  }

  private async merge(ctx: ExtensionContext, runId?: string): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const store = new RunStore(join(repoRoot, this.configDirName, "capstan", "runs"));
    const run = runId ? await store.load(runId) : this.activeRun;
    if (!run?.git || (run.outcome !== "branch" && !run.merged.length)) return void ctx.ui.notify("没有可落地的 last-green branch 结果", "warning");
    const config = this.activeConfig ?? await loadConfig(this.agentDir, run.cwd, this.configDirName);
    const workspace = new WorkspaceManager({ cwd: run.cwd, runId: run.runId, runDir: run.runDir, worktreesRoot: join(this.agentDir, "capstan", "worktrees") });
    workspace.restore(run.git);
    const lock = await RepoLock.forRepo(run.cwd, `merge-${run.runId}`);
    await lock.acquire();
    try {
      const landing = await workspace.land("apply");
      run.outcome = landing.outcome;
      await store.save(run);
      ctx.ui.notify(landing.note, landing.outcome === "branch" ? "warning" : "info");
    } finally {
      await lock.release();
    }
  }

  private async replan(ctx: ExtensionContext): Promise<void> {
    const orchestrator = this.activeOrchestrator;
    const run = this.activeRun;
    if (!orchestrator || !run?.plan) return void ctx.ui.notify("没有可重规划的活跃 capstan", "warning");
    await orchestrator.pause();
    try {
      const edited = await ctx.ui.editor("运行中重规划（已启动任务的目标/依赖/作用域不可修改）", JSON.stringify(run.plan, null, 2));
      if (!edited) return;
      const plan = JSON.parse(edited) as CapstanPlan;
      const validation = validatePlan(plan, orchestrator.config.planner.maxSubtasks);
      if (!validation.ok) throw new Error(`重规划校验失败: ${validation.errors.join("; ")}`);
      await orchestrator.replacePlan(plan);
      ctx.ui.notify(`已应用计划 revision ${run.planRevision}`, "info");
    } finally {
      await orchestrator.resume();
    }
  }

  private async createPullRequest(ctx: ExtensionContext, runId?: string): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd);
    if (!repoRoot) return void ctx.ui.notify("非 Git 仓库", "warning");
    const store = new RunStore(join(repoRoot, this.configDirName, "capstan", "runs"));
    const run = runId ? await store.load(runId) : this.activeRun;
    if (!run?.git || !run.merged.length) return void ctx.ui.notify("没有可发布的 last-green capstan branch", "warning");
    const branch = run.git.integrationBranch;
    if (!(await ctx.ui.confirm("创建 GitHub Pull Request", `将 ${branch} 推送到 origin，并创建不包含本地日志/报告正文的 PR？`))) return;
    const lock = await RepoLock.forRepo(repoRoot, `pr-${run.runId}`);
    await lock.acquire();
    try {
      const pushed = await runCommand("git", ["push", "--set-upstream", "origin", branch], { cwd: repoRoot, timeoutMs: 120_000 });
      if (pushed.exitCode !== 0) throw new Error(`git push 失败: ${pushed.stderr || pushed.stdout}`);
      const title = `capstan: verified run ${run.runId}`;
      const body = `Pi Capstan run ${run.runId}.\n\nMerged verified subtasks: ${run.merged.join(", ")}.\nResult: ${run.partialSuccess ? "partial; failed dependencies excluded" : "complete"}.\n\nLocal RPC logs, sessions, and reports were not uploaded by this command.`;
      const created = await runCommand("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], { cwd: repoRoot, timeoutMs: 120_000 });
      if (created.exitCode !== 0) throw new Error(`gh pr create 失败: ${created.stderr || created.stdout}`);
      run.prUrl = created.stdout.trim().split("\n").find((line) => /^https:\/\//.test(line));
      await store.save(run);
      ctx.ui.notify(run.prUrl ? `PR 已创建: ${run.prUrl}` : "PR 已创建", "info");
    } finally {
      await lock.release();
    }
  }

  private async clean(ctx: ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd);
    if (!repoRoot) return void ctx.ui.notify("非 Git 仓库", "warning");
    const store = new RunStore(join(repoRoot, this.configDirName, "capstan", "runs"));
    const runs = (await store.list()).filter((run) => ["done", "failed", "aborted"].includes(run.phase) && run.git);
    if (!runs.length) return void ctx.ui.notify("没有可清理 run", "info");
    const id = await ctx.ui.select("选择要清理的 run", runs.map((run) => run.runId));
    const run = runs.find((item) => item.runId === id);
    if (!run || !(await ctx.ui.confirm("确认清理", `移除 ${run.runId} 的 worktree 和 capstan 分支？运行日志保留。`))) return;
    const workspace = new WorkspaceManager({ cwd: repoRoot, runId: run.runId, runDir: run.runDir, worktreesRoot: join(this.agentDir, "capstan", "worktrees") });
    workspace.restore(run.git!);
    await workspace.cleanupWorktrees(false);
    ctx.ui.notify("已清理 worktree 与分支；日志仍可回放", "info");
  }

  private async cases(ctx: ExtensionContext, args: string[]): Promise<void> {
    const config = this.activeConfig ?? await loadConfig(this.agentDir, ctx.cwd, this.configDirName);
    const store = new CaseStore(join(this.agentDir, "capstan", "cases"), config.caseStore.max, config.caseStore.threshold, config.caseStore.matcher);
    if (args[0] === "rate" && args[1]) {
      const rating = args[2] === "+1" ? 1 : args[2] === "-1" ? -1 : 0;
      await store.rate(args[1], rating);
      return void ctx.ui.notify(`case ${args[1]} 评分 ${rating}`, "info");
    }
    if (args[0] === "delete" && args[1]) {
      if (await ctx.ui.confirm("删除案例", args[1])) await store.delete(args[1]);
      return;
    }
    const records = await store.list();
    ctx.ui.notify(records.slice(0, 20).map((record) => `${record.id} ${record.taskText} score=${record.rating.explicit * 2 + record.rating.implicit}`).join("\n") || "案例库为空/默认关闭", "info");
  }

  private async replay(ctx: ExtensionContext, runId?: string): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const store = new RunStore(join(repoRoot, this.configDirName, "capstan", "runs"));
    const run = runId ? await store.load(runId) : (await store.list())[0];
    if (!run) return void ctx.ui.notify("未找到 run", "warning");
    const report = run.reportPath && await pathExists(run.reportPath) ? await readFile(run.reportPath, "utf8") : JSON.stringify(run, null, 2);
    this.pi.sendMessage({ customType: "capstan-report", content: report, display: true, details: { runId: run.runId, replay: true } }, { deliverAs: "nextTurn" });
  }

  private async configure(ctx: ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const useWizard = await ctx.ui.confirm(
      "Configuration wizard",
      "Use the interactive wizard to generate a project config? (No opens the JSON editor.)",
    );
    if (useWizard) return this.configureWithWizard(ctx, repoRoot);

    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    const edited = await ctx.ui.editor("Project Capstan config", JSON.stringify(config, null, 2));
    if (!edited) return;
    JSON.parse(edited);
    const path = join(repoRoot, this.configDirName, "capstan.json");
    await ensurePrivateDir(join(repoRoot, this.configDirName));
    await writeFile(path, `${edited.trim()}\n`, { mode: 0o600 });
    ctx.ui.notify(`Wrote ${path}`, "info");
  }

  private async configureWithWizard(ctx: ExtensionContext, repoRoot: string): Promise<void> {
    ctx.ui.notify("Configuration wizard — edit the template, keep one option per section.", "info");
    const questionsText = `# Pi-Capstan configuration wizard

Keep one choice per section (delete the others).

## 1. Use case (required)
- large-refactor
- production-feature
- untrusted-code
- fast-iteration

## 2. Max budget USD (optional)
maxBudget: 20

## 3. Quality preference (required)
- fast
- balanced
- high

## 4. Verification level (required)
- minimal
- standard
- comprehensive
`;
    const response = await ctx.ui.editor("Configuration wizard", questionsText);
    if (!response) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const answers: WizardAnswers = {
      useCase: "production-feature",
      qualityLevel: "balanced",
      verification: "standard",
    };
    for (const line of response.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) {
        const value = trimmed.slice(1).trim().split("#")[0]!.trim();
        if (["large-refactor", "production-feature", "untrusted-code", "fast-iteration"].includes(value)) {
          answers.useCase = value as WizardAnswers["useCase"];
        } else if (["fast", "balanced", "high"].includes(value)) {
          answers.qualityLevel = value as WizardAnswers["qualityLevel"];
        } else if (["minimal", "standard", "comprehensive"].includes(value)) {
          answers.verification = value as WizardAnswers["verification"];
        }
      } else if (trimmed.startsWith("maxBudget:")) {
        const budget = Number(trimmed.split(":")[1]?.trim());
        if (Number.isFinite(budget) && budget > 0) answers.maxBudget = budget;
      }
    }

    const config = generateConfigFromAnswers(answers);
    ctx.ui.notify(`\n${describeConfig(config, answers)}\n`, "info");
    if (!(await ctx.ui.confirm("Save configuration", "Save this configuration to the project?"))) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }
    const configPath = join(repoRoot, this.configDirName, "capstan.json");
    await ensurePrivateDir(join(repoRoot, this.configDirName));
    writeConfigWithComments(configPath, config, answers);
    ctx.ui.notify(`Saved ${configPath}\nDocs: ${DOCS_BASE_URL}/CONFIGURATION.md · Templates: ${DOCS_BASE_URL}/examples/TEMPLATES.md`, "info");
  }

  private async analyzeRuns(ctx: ExtensionContext, args: string[]): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const limitFlag = args.findIndex((arg) => arg === "--limit");
    const limit = limitFlag >= 0 ? Math.max(1, Number(args[limitFlag + 1]) || 50) : 50;
    const wantRecommendations = args.includes("--recommendations") || !args.includes("--summary-only");
    const analyzer = new RunAnalyzer(join(repoRoot, this.configDirName, "capstan", "runs"));
    const summaries = await analyzer.loadRunHistory(limit);
    if (!summaries.length) {
      ctx.ui.notify("No capstan runs found to analyze.", "warning");
      return;
    }
    const trends = await analyzer.analyzeTrends(summaries);
    const recommendations = wantRecommendations ? await analyzer.getRecommendations(trends) : [];
    const report = analyzer.formatReport(summaries, trends, recommendations);
    this.pi.sendMessage(
      { customType: "capstan-report", content: report, display: true, details: { analyze: true } },
      { deliverAs: "nextTurn" },
    );
    ctx.ui.notify(`Analyzed ${summaries.length} run(s). Report injected into the session.`, "info");
  }

  private async validateConfiguration(ctx: ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);

    const result = validateConfig(config);
    const formatted = formatValidationResult(result);

    ctx.ui.notify(formatted, result.valid ? "info" : "warning");

    if (!result.valid || result.issues.some(i => i.level === "warning")) {
      if (await ctx.ui.confirm("配置验证", "是否尝试自动修复问题？")) {
        const { fixed, changes } = autoFixConfig(config);

        if (changes.length > 0) {
          const changesText = "自动修复:\n" + changes.map(c => `  • ${c}`).join("\n");
          ctx.ui.notify(changesText, "info");

          const edited = await ctx.ui.editor("查看修复后的配置", JSON.stringify(fixed, null, 2));
          if (edited) {
            const path = join(repoRoot, this.configDirName, "capstan.json");
            await ensurePrivateDir(join(repoRoot, this.configDirName));
            await writeFile(path, `${edited.trim()}\n`, { mode: 0o600 });
            ctx.ui.notify(`已写入 ${path}`, "info");
          }
        } else {
          ctx.ui.notify("未找到可自动修复的问题", "info");
        }
      }
    }
  }

  private help(ctx: ExtensionContext): void {
    ctx.ui.notify(
      "Capstan — parallel coding agents under your control\n\n" +
        "Start:   /capstan \"implement X\"      you approve the plan before anything runs\n" +
        "Control: /capstan board | pause | resume | abort\n" +
        "Land:    /capstan merge | pr          merge the integration branch or open a PR\n" +
        "Tune:    /capstan config | validate   optional — safe defaults are already on\n" +
        "More:    /capstan replan | clean | cases | replay | analyze\n" +
        "Flags:   --force --solo --plan-only --max N --budget USD --best-of N --model provider/id\n" +
        "Docs:    https://github.com/Yongthyuan/pi-capstan/tree/main/docs",
    "info");
  }
}

function newRun(runId: string, runDir: string, cwd: string, task: string, gate?: any, plan?: CapstanPlan): CapstanRun {
  return {
    schemaVersion: 1,
    runId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd,
    task,
    phase: "gating",
    gate,
    plan,
    planEdits: [],
    planRevision: 1,
    workers: {},
    merged: [],
    conflicts: [],
    totals: { ...emptyUsage(), wallSec: 0, turns: 0 },
    runDir,
  };
}

async function detectRepoRoot(cwd: string): Promise<string | undefined> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function addRunExclude(repoRoot: string, configDirName: string): Promise<void> {
  const gitPath = (await runCommand("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot })).stdout.trim();
  if (!gitPath) return;
  const path = isAbsolute(gitPath) ? gitPath : join(repoRoot, gitPath);
  await ensurePrivateDir(dirname(path));
  const line = `/${configDirName}/capstan/`;
  const current = await pathExists(path) ? await readFile(path, "utf8") : "";
  if (!current.split("\n").includes(line)) await appendFile(path, `${current.endsWith("\n") || !current ? "" : "\n"}${line}\n`);
}

async function routeUi(ctx: ExtensionContext, request: any): Promise<Record<string, unknown>> {
  if (request.method === "confirm") return { id: request.id, confirmed: await ctx.ui.confirm(request.title ?? "Worker confirmation", request.message ?? "") };
  if (request.method === "select") {
    const value = await ctx.ui.select(request.title ?? "Worker selection", request.options ?? []);
    return value === undefined ? { id: request.id, cancelled: true } : { id: request.id, value };
  }
  if (request.method === "input") {
    const value = await ctx.ui.input(request.title ?? "Worker input", request.placeholder);
    return value === undefined ? { id: request.id, cancelled: true } : { id: request.id, value };
  }
  const value = await ctx.ui.editor(request.title ?? "Worker editor", request.prefill ?? "");
  return value === undefined ? { id: request.id, cancelled: true } : { id: request.id, value };
}
