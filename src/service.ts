import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParsedSwarmCommand, SwarmConfig, SwarmPlan, SwarmRun } from "./types.ts";
import { CaseStore } from "./cases.ts";
import { loadConfig } from "./config.ts";
import { decideGate } from "./gate.ts";
import { PiLlmClient } from "./llm.ts";
import { buildRepoBrief, createPlan, type RepoBrief } from "./planner.ts";
import { pruneRunArtifacts, RunStore } from "./state.ts";
import { WorkspaceManager } from "./workspace.ts";
import { Orchestrator } from "./orchestrator.ts";
import { addUsage, emptyUsage, ensurePrivateDir, makeRunId, pathExists, runCommand } from "./utils.ts";
import { reviewPlan } from "./ui/plan-panel.ts";
import { renderRunText, showDashboard, widgetLines } from "./ui/dashboard.ts";
import { RepoLock } from "./repo-lock.ts";

export class SwarmService {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly configDirName: string;
  activeRun?: SwarmRun;
  activeOrchestrator?: Orchestrator;
  private activeConfig?: SwarmConfig;

  constructor(pi: ExtensionAPI, agentDir: string, configDirName: string) {
    this.pi = pi;
    this.agentDir = agentDir;
    this.configDirName = configDirName;
  }

  async handle(parsed: ParsedSwarmCommand, ctx: ExtensionCommandContext): Promise<void> {
    if (parsed.action === "run") return this.runTask(parsed.task, ctx, parsed);
    if (parsed.action === "board") return this.board(ctx);
    if (parsed.action === "pause") return this.pause(ctx);
    if (parsed.action === "resume") return this.resume(ctx);
    if (parsed.action === "abort") return this.abort(ctx);
    if (parsed.action === "status") return void ctx.ui.notify(renderRunText(this.activeRun), "info");
    if (parsed.action === "merge") return this.merge(ctx);
    if (parsed.action === "clean") return this.clean(ctx);
    if (parsed.action === "cases") return this.cases(ctx, parsed.rest);
    if (parsed.action === "replay") return this.replay(ctx, parsed.rest[0]);
    if (parsed.action === "config") return this.configure(ctx);
    return this.help(ctx);
  }

  async runTask(task: string, ctx: ExtensionContext, options: Partial<ParsedSwarmCommand> = {}): Promise<void> {
    if (this.activeRun && !["done", "failed", "aborted"].includes(this.activeRun.phase)) throw new Error(`已有活跃 run ${this.activeRun.runId}`);
    if (options.solo) {
      this.pi.sendUserMessage(task);
      return;
    }
    const detectedRepoRoot = await detectRepoRoot(ctx.cwd);
    const repoRoot = detectedRepoRoot ?? ctx.cwd;
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    await pruneRunArtifacts(join(repoRoot, this.configDirName, "swarm", "runs"), config.retention);
    const currentModel = (ctx as any).model as { provider?: string; id?: string } | undefined;
    if (!config.worker.model && currentModel?.provider && currentModel.id) config.worker.model = `${currentModel.provider}/${currentModel.id}`;
    if (options.max) config.worker.maxConcurrency = Math.max(1, Math.min(8, Math.trunc(options.max)));
    if (options.budget) config.run.budgetUsd = options.budget;
    if (options.model) config.worker.model = options.model;
    this.activeConfig = config;
    const runId = makeRunId();
    const runsRoot = join(repoRoot, this.configDirName, "swarm", "runs");
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
      this.pi.appendEntry("swarm-run", { runId, phase: run.phase, task, runDir });
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
        ctx.ui.notify(`swarm: ${gate.reason}，已交回主会话`, "info");
        this.pi.sendUserMessage(task);
        return;
      }
      run.phase = "planning";
      await store.save(run);
      const caseStore = new CaseStore(join(this.agentDir, "swarm", "cases"), config.caseStore.max, config.caseStore.threshold);
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
        this.pi.sendMessage({ customType: "swarm-report", content: `# Swarm Plan · ${planned.taskSummary}\n\n\`\`\`json\n${JSON.stringify(planned, null, 2)}\n\`\`\``, display: true, details: { runId, planOnly: true } }, { deliverAs: "nextTurn" });
        return;
      }
      const reviewed = await reviewPlan(ctx, planned, gate, config.planner.maxSubtasks);
      if (!reviewed.plan) {
        run.phase = "aborted";
        run.outcome = "aborted";
        await store.save(run);
        ctx.ui.notify("已取消 swarm", "info");
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
      ctx.ui.notify(`swarm ${runId} 已启动；/swarm board 查看`, "info");
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
    const store = new RunStore(join(repoRoot, this.configDirName, "swarm", "runs"));
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    await pruneRunArtifacts(store.runsRoot, config.retention);
    const unfinished = await store.unfinished();
    if (store.diagnostics.length) ctx.ui.notify(`有 ${store.diagnostics.length} 个 swarm 状态损坏；请用运行目录中的 state.prev.json 排查`, "warning");
    if (unfinished.length) ctx.ui.notify(`发现 ${unfinished.length} 个未完成 swarm run；使用 /swarm resume`, "warning");
  }

  async onSessionShutdown(): Promise<void> {
    await this.activeOrchestrator?.interrupt();
  }

  private makeOrchestrator(run: SwarmRun, config: SwarmConfig, store: RunStore, brief: RepoBrief, caseStore: CaseStore, ctx: ExtensionContext, repoLock?: RepoLock): Orchestrator {
    const workspace = new WorkspaceManager({ cwd: run.cwd, runId: run.runId, runDir: run.runDir, worktreesRoot: join(this.agentDir, "swarm", "worktrees") });
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
          ctx.ui.setWidget("swarm", widgetLines(updated));
          ctx.ui.setStatus("swarm", renderRunText(updated));
        },
        onUi: (_workerId, request) => routeUi(ctx, request),
        onBudget: async (workerId, message) => {
          const choice = await ctx.ui.select(`Swarm 预算门 ${workerId}\n${message}`, ["增加 25% 并继续", "停止整个 run"]);
          return choice === "增加 25% 并继续" ? "extend" : "stop";
        },
        onBeforeReport: async (updated) => {
          if (config.caseStore.enabled) {
            const record = await caseStore.record(updated, brief);
            if (record) updated.caseId = record.id, await store.save(updated);
          }
        },
        onReport: async (updated, report) => {
          this.pi.sendMessage({ customType: "swarm-report", content: report, display: true, details: { runId: updated.runId, outcome: updated.outcome } }, { deliverAs: "nextTurn", triggerTurn: config.ui.reportTriggerTurn });
          this.pi.appendEntry("swarm-run", { runId: updated.runId, phase: updated.phase, outcome: updated.outcome, reportPath: updated.reportPath });
          ctx.ui.setWidget("swarm", undefined);
          ctx.ui.setStatus("swarm", undefined);
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
    if (!this.activeOrchestrator) return void ctx.ui.notify("没有活跃 swarm", "warning");
    await this.activeOrchestrator.pause();
    ctx.ui.notify("swarm 已暂停", "info");
  }

  private async resume(ctx: ExtensionContext): Promise<void> {
    if (this.activeOrchestrator) {
      await this.activeOrchestrator.resume();
      ctx.ui.notify("swarm 已继续", "info");
      return;
    }
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const store = new RunStore(join(repoRoot, this.configDirName, "swarm", "runs"));
    const runs = (await store.list()).filter((run) => !["done", "aborted"].includes(run.phase) && Boolean(run.plan));
    if (!runs.length) return void ctx.ui.notify("没有可恢复 run", "info");
    const selectedId = runs.length === 1 ? runs[0]!.runId : await ctx.ui.select("选择 run", runs.map((item) => item.runId));
    const chosen = runs.find((run) => run.runId === selectedId);
    if (!chosen?.plan) return;
    chosen.phase = "executing";
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    this.activeConfig = config;
    const brief = await buildRepoBrief(repoRoot, chosen.task, config.planner.repoMapTokens * 4);
    const caseStore = new CaseStore(join(this.agentDir, "swarm", "cases"), config.caseStore.max, config.caseStore.threshold);
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
    if (!this.activeOrchestrator) return void ctx.ui.notify("没有活跃 swarm", "warning");
    if (await ctx.ui.confirm("终止 swarm", "停止所有 worker 并保留排障数据？")) await this.activeOrchestrator.abort();
  }

  private async merge(ctx: ExtensionContext): Promise<void> {
    const run = this.activeRun;
    if (!run?.git || run.outcome !== "branch") return void ctx.ui.notify("当前没有 branch 结果可落地", "warning");
    const config = this.activeConfig ?? await loadConfig(this.agentDir, run.cwd, this.configDirName);
    const workspace = new WorkspaceManager({ cwd: run.cwd, runId: run.runId, runDir: run.runDir, worktreesRoot: join(this.agentDir, "swarm", "worktrees") });
    workspace.restore(run.git);
    const landing = await workspace.land("apply");
    run.outcome = landing.outcome;
    await new RunStore(join(run.cwd, this.configDirName, "swarm", "runs")).save(run);
    ctx.ui.notify(landing.note, landing.outcome === "branch" ? "warning" : "info");
  }

  private async clean(ctx: ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd);
    if (!repoRoot) return void ctx.ui.notify("非 Git 仓库", "warning");
    const store = new RunStore(join(repoRoot, this.configDirName, "swarm", "runs"));
    const runs = (await store.list()).filter((run) => ["done", "failed", "aborted"].includes(run.phase) && run.git);
    if (!runs.length) return void ctx.ui.notify("没有可清理 run", "info");
    const id = await ctx.ui.select("选择要清理的 run", runs.map((run) => run.runId));
    const run = runs.find((item) => item.runId === id);
    if (!run || !(await ctx.ui.confirm("确认清理", `移除 ${run.runId} 的 worktree 和 swarm 分支？运行日志保留。`))) return;
    const workspace = new WorkspaceManager({ cwd: repoRoot, runId: run.runId, runDir: run.runDir, worktreesRoot: join(this.agentDir, "swarm", "worktrees") });
    workspace.restore(run.git!);
    await workspace.cleanupWorktrees(false);
    ctx.ui.notify("已清理 worktree 与分支；日志仍可回放", "info");
  }

  private async cases(ctx: ExtensionContext, args: string[]): Promise<void> {
    const config = this.activeConfig ?? await loadConfig(this.agentDir, ctx.cwd, this.configDirName);
    const store = new CaseStore(join(this.agentDir, "swarm", "cases"), config.caseStore.max, config.caseStore.threshold);
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
    const store = new RunStore(join(repoRoot, this.configDirName, "swarm", "runs"));
    const run = runId ? await store.load(runId) : (await store.list())[0];
    if (!run) return void ctx.ui.notify("未找到 run", "warning");
    const report = run.reportPath && await pathExists(run.reportPath) ? await readFile(run.reportPath, "utf8") : JSON.stringify(run, null, 2);
    this.pi.sendMessage({ customType: "swarm-report", content: report, display: true, details: { runId: run.runId, replay: true } }, { deliverAs: "nextTurn" });
  }

  private async configure(ctx: ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot(ctx.cwd) ?? ctx.cwd;
    const config = await loadConfig(this.agentDir, repoRoot, this.configDirName);
    const edited = await ctx.ui.editor("项目 Swarm 配置", JSON.stringify(config, null, 2));
    if (!edited) return;
    JSON.parse(edited);
    const path = join(repoRoot, this.configDirName, "swarm.json");
    await ensurePrivateDir(join(repoRoot, this.configDirName));
    await writeFile(path, `${edited.trim()}\n`, { mode: 0o600 });
    ctx.ui.notify(`已写入 ${path}`, "info");
  }

  private help(ctx: ExtensionContext): void {
    ctx.ui.notify("/swarm <task> [--force --plan-only --max N --budget USD --model provider/id]\n/swarm board|pause|resume|abort|merge|clean|cases|replay|config|status", "info");
  }
}

function newRun(runId: string, runDir: string, cwd: string, task: string, gate?: any, plan?: SwarmPlan): SwarmRun {
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
  const line = `/${configDirName}/swarm/`;
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
