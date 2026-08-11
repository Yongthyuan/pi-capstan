import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkerHandle } from "../src/worker.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { WorkspaceManager } from "../src/workspace.ts";
import { RunStore } from "../src/state.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { emptyUsage, runCommand } from "../src/utils.ts";

const PASS_COMMAND = 'node -e "process.exit(0)"';
const FAIL_COMMAND = 'node -e "process.exit(1)"';

test("worker handle speaks strict JSONL RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-worker-"));
  try {
    const fake = await writeFakePi(root);
    const prompt = join(root, "prompt.md");
    const guard = join(root, "guard.ts");
    await writeFile(prompt, "role");
    await writeFile(guard, "export default () => {};");
    const worker = new WorkerHandle({ id: "w1", title: "fake", worktree: root, runDir: root, guardPath: guard, promptPath: prompt, sessionDir: join(root, "sessions"), tools: ["read"], projectTrusted: false, piCommand: process.execPath, piArgsPrefix: [fake] });
    let text = "";
    worker.on("text", (event) => (text = event.text));
    await worker.prompt("go", 5_000);
    assert.equal(text.includes("Completion Report"), true);
    assert.equal(worker.usage.output, 5);
    assert.equal(resolve(worker.sessionFile!), resolve(root, "fake-session.jsonl"));
    await worker.stop(50);
    assert.equal(worker.running, false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });
  }
});

test("orchestrator completes two-worker branch-only vertical slice", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-orchestrator-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    const fake = await writeFakePi(root);
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const runDir = join(repo, ".pi", "swarm", "runs", "r1");
    const plan: any = {
      schemaVersion: 1, taskSummary: "fake parallel", strategy: "two workers", contracts: [],
      subtasks: [
        { id: "a", title: "a", goal: "a", role: "a", rolePrompt: "a", ownedPaths: ["src/a/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } },
        { id: "b", title: "b", goal: "b", role: "b", rolePrompt: "b", ownedPaths: ["src/b/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } },
      ], mergeOrder: ["a", "b"], risks: [],
    };
    const run: any = { schemaVersion: 1, runId: "r1", createdAt: Date.now(), updatedAt: Date.now(), cwd: repo, task: "fake", phase: "reviewing", plan, planEdits: [], workers: {}, merged: [], conflicts: [], totals: { ...emptyUsage(), wallSec: 0, turns: 0 }, runDir };
    const config = structuredClone(DEFAULT_CONFIG);
    config.run.verify.integrationLight = [];
    config.run.verify.full = [];
    config.run.verifyAllowedPrefixes = ["node -e"];
    config.worker.maxConcurrency = 2;
    const store = new RunStore(join(repo, ".pi", "swarm", "runs"));
    let report = "";
    const orchestrator = new Orchestrator({
      run, config, store, agentDir: join(root, "agent"),
      workspace: new WorkspaceManager({ cwd: repo, runId: "r1", runDir, worktreesRoot: join(root, "worktrees") }),
      workerFactory: (options) => new WorkerHandle({ ...options, piCommand: process.execPath, piArgsPrefix: [fake] }),
      hooks: { projectTrusted: false, onUpdate: () => {}, onUi: async (_id, request) => ({ id: request.id, cancelled: true }), onBudget: async () => "stop", onReport: async (_run, value) => { report = value; } },
    });
    await orchestrator.execute(false);
    assert.equal(run.phase, "done", run.error);
    assert.equal(run.outcome, "branch");
    assert.deepEqual(run.merged, ["a", "b"]);
    assert.equal(report.includes("Swarm 完成"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pause is a real barrier and resumes interrupted worker turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-pause-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "pause", 300);
    const execution = fixture.orchestrator.execute(false);
    await waitFor(() => Object.values(fixture.run.workers).filter((worker: any) => worker.status === "working").length === 2);
    await fixture.orchestrator.pause();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(fixture.run.merged, []);
    assert.equal(Object.values(fixture.run.workers).every((worker: any) => worker.status === "paused"), true);
    await fixture.orchestrator.resume();
    await execution;
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.deepEqual(fixture.run.merged, ["a", "b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("budget gate aborts the turn, asks once, and continues only after extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-budget-"));
  try {
    let budgetPrompts = 0;
    const fixture = await makeOrchestratorFixture(root, "budget", 20, async () => {
      budgetPrompts++;
      return "extend";
    });
    fixture.config.worker.perAgentBudgetUsd = 0.0001;
    fixture.config.run.budgetUsd = 0.0001;
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.equal(budgetPrompts >= 1, true);
    assert.equal(fixture.config.run.budgetUsd > 0.0001, true);
    assert.equal(fixture.run.effectiveBudget.runBudgetUsd > 0.0001, true);
    assert.equal((await fixture.store.load("budget")).effectiveBudget!.runBudgetUsd > 0.0001, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stall watchdog steers once then fails a persistently silent worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-stall-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "stall", 5_000);
    fixture.config.worker.stallSec = 0.05;
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "failed");
    assert.equal(Object.values(fixture.run.workers).some((worker: any) => worker.currentAction.includes("stalled twice")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stall watchdog exempts a long-running active tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-tool-stall-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "tool-stall", 300, async () => "stop", { FAKE_PI_TOOL_ACTIVE: "1" });
    fixture.config.worker.stallSec = 0.05;
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.equal(Object.values(fixture.run.workers).every((worker: any) => worker.activeTools === 0), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detach affects only one worker and a later orchestrator can resume it", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-detach-"));
  try {
    const first = await makeOrchestratorFixture(root, "detach", 500);
    const execution = first.orchestrator.execute(false);
    await waitFor(() => first.run.workers.a?.status === "working");
    const takeover = await first.orchestrator.detachWorker("a");
    await execution;
    assert.equal(first.run.phase, "done");
    assert.equal(first.run.workers.a.status, "detached");
    assert.deepEqual(first.run.merged, ["b"]);
    assert.equal(first.run.partialSuccess, true);
    const { access } = await import("node:fs/promises");
    await access(first.run.workers.a.worktree);
    assert.equal(takeover?.includes("--no-extensions"), true);
    assert.equal(takeover?.includes("PI_SWARM_WORKER"), true);
    assert.equal(takeover?.includes("'-e'"), true);

    first.run.phase = "executing";
    first.run.workers.a.status = "pending";
    first.run.workers.a.usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
    first.run.workers.a.turns = 5;
    const resumed = new Orchestrator({
      run: first.run,
      config: first.config,
      store: first.store,
      agentDir: join(root, "agent"),
      workspace: new WorkspaceManager({ cwd: first.repo, runId: "detach", runDir: first.run.runDir, worktreesRoot: join(root, "worktrees") }),
      workerFactory: (options) => new WorkerHandle({ ...options, piCommand: process.execPath, piArgsPrefix: [first.fake], extraEnv: { FAKE_PI_DELAY_MS: "20" } }),
      hooks: { projectTrusted: false, onUpdate: () => {}, onUi: async (_id, request) => ({ id: request.id, cancelled: true }), onBudget: async () => "stop", onReport: async () => {} },
    });
    await resumed.execute(false);
    assert.equal(first.run.phase, "done", first.run.error);
    assert.deepEqual(first.run.merged, ["a", "b"]);
    assert.equal(first.run.workers.a.usage.input > 100, true);
    assert.equal(first.run.workers.a.turns > 5, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent workers continue after one failure and dependent work is blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-partial-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "partial", 20);
    fixture.run.plan.subtasks[0].acceptance.commands = [FAIL_COMMAND];
    fixture.run.plan.subtasks.push({ id: "c", title: "c", goal: "c", role: "c", rolePrompt: "c", ownedPaths: ["src/c/**"], readPaths: [], dependsOn: ["a"], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } });
    fixture.run.plan.mergeOrder = ["a", "b", "c"];
    fixture.config.run.verifyAllowedPrefixes = ["node -e"];
    fixture.config.worker.maxRetries = 0;
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.deepEqual(fixture.run.merged, ["b"]);
    assert.equal(fixture.run.workers.a.status, "failed");
    assert.equal(fixture.run.workers.c.status, "blocked");
    assert.deepEqual(fixture.run.workers.c.blockedBy, ["a"]);
    assert.equal(fixture.run.partialSuccess, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slot scheduler starts queued work as soon as one slot frees", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-slots-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "slots", 20, async () => "stop", { FAKE_PI_DELAY_MAP: JSON.stringify({ a: 600, b: 20, c: 20 }) });
    fixture.run.plan.subtasks.push({ id: "c", title: "c", goal: "c", role: "c", rolePrompt: "c", ownedPaths: ["src/c/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } });
    fixture.run.plan.mergeOrder = ["a", "b", "c"];
    const execution = fixture.orchestrator.execute(false);
    await waitFor(() => Boolean(fixture.run.workers.c?.startedAt));
    assert.notEqual(fixture.run.workers.a.status, "done");
    assert.equal(fixture.run.workers.a.endedAt, undefined);
    await execution;
    assert.deepEqual(fixture.run.merged, ["a", "b", "c"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime replan can add pending work without mutating started tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-replan-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "replan", 250);
    const execution = fixture.orchestrator.execute(false);
    await waitFor(() => fixture.run.workers.a?.status === "working" && fixture.run.workers.b?.status === "working");
    await fixture.orchestrator.pause();
    const plan = structuredClone(fixture.run.plan);
    plan.subtasks.push({ id: "c", title: "c", goal: "c", role: "c", rolePrompt: "c", ownedPaths: ["src/c/**"], readPaths: [], dependsOn: ["a"], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } });
    plan.mergeOrder.push("c");
    await fixture.orchestrator.replacePlan(plan);
    await fixture.orchestrator.resume();
    await execution;
    assert.equal(fixture.run.planRevision, 2);
    assert.deepEqual(fixture.run.merged, ["a", "b", "c"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("simultaneous worker approvals are routed as one batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-ui-batch-"));
  try {
    let batches = 0;
    const fixture = await makeOrchestratorFixture(root, "ui-batch", 20, async () => "stop", { FAKE_PI_UI: "1" }, async (requests) => {
      batches++;
      assert.equal(requests.length, 2);
      return Object.fromEntries(requests.map(({ request }) => [request.id, { id: request.id, confirmed: true }]));
    });
    fixture.config.ui.approvalBatchMs = 50;
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.equal(batches, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("best-of-N runs isolated candidates and records the selected winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-best-of-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "best-of", 20);
    fixture.config.worker.bestOfN = 2;
    fixture.config.worker.bestOfNJudge = true;
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.deepEqual(fixture.run.merged, ["a", "b"]);
    assert.equal(fixture.run.workers.a.competition.attempts.length, 2);
    assert.match(fixture.run.workers.a.competition.winner, /^a-try-/);
    assert.equal(Object.keys(fixture.run.workers).some((id) => /-try-/.test(id)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted setup runs before worker and integration verification without spending retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-setup-"));
  try {
    const fixture = await makeOrchestratorFixture(root, "setup", 20, async () => "stop", {}, undefined, true);
    fixture.config.worker.setupCommands = ['node -e "require(\'fs\').mkdirSync(\'node_modules\',{recursive:true}),require(\'fs\').writeFileSync(\'node_modules/setup.marker\',\'ok\')"'];
    fixture.config.run.setupAllowedPrefixes = ["node -e"];
    await fixture.orchestrator.execute(false);
    assert.equal(fixture.run.phase, "done", fixture.run.error);
    assert.equal(Object.values(fixture.run.workers).every((worker: any) => worker.retries === 0 && worker.setupComplete), true);
    assert.equal(fixture.run.gitOperations.every((operation: any) => operation.setupComplete), true);
    assert.equal(fixture.run.integrationSetupComplete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFakePi(root: string): Promise<string> {
  const path = join(root, "fake-pi.mjs");
  await writeFile(path, `import readline from "node:readline";
const root = ${JSON.stringify(root)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const workerId = process.argv.join(" ").match(/swarm\\/([A-Za-z0-9_-]+)/)?.[1] ?? "unknown";
const delayMap = JSON.parse(process.env.FAKE_PI_DELAY_MAP ?? "{}");
const delay = Number(delayMap[workerId] ?? process.env.FAKE_PI_DELAY_MS ?? 10);
const activeTool = process.env.FAKE_PI_TOOL_ACTIVE === "1";
const requestUi = process.env.FAKE_PI_UI === "1";
let activeTimer;
let waitingUi = false;
function out(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function finish() {
  if (activeTool) out({ type: "tool_execution_end", toolName: "bash" });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Completion Report\\n- done" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } });
  out({ type: "agent_settled" });
}
rl.on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionFile: root + "/fake-session.jsonl", sessionId: "fake" } });
  else if (cmd.type === "prompt") {
    out({ id: cmd.id, type: "response", command: "prompt", success: true });
    if (activeTool) out({ type: "tool_execution_start", toolName: "bash", args: { command: "long-running-test" } });
    if (requestUi) {
      waitingUi = true;
      out({ type: "extension_ui_request", id: "ui-" + workerId, method: "confirm", title: "approve " + workerId, message: "continue?" });
      return;
    }
    activeTimer = setTimeout(() => {
      activeTimer = undefined;
      finish();
    }, delay);
  } else if (cmd.type === "extension_ui_response" && waitingUi) {
    waitingUi = false;
    activeTimer = setTimeout(() => { activeTimer = undefined; finish(); }, delay);
  } else if (cmd.type === "abort") {
    if (activeTimer) clearTimeout(activeTimer), (activeTimer = undefined);
    out({ type: "agent_settled" });
    out({ id: cmd.id, type: "response", command: "abort", success: true });
  }
  else if (cmd.type === "steer") out({ id: cmd.id, type: "response", command: "steer", success: true });
});
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function makeOrchestratorFixture(
  root: string,
  runId: string,
  delayMs: number,
  onBudget: () => Promise<"extend" | "stop"> = async () => "stop",
  extraEnv: NodeJS.ProcessEnv = {},
  onUiBatch?: (requests: Array<{ workerId: string; request: any }>) => Promise<Record<string, Record<string, unknown>>>,
  projectTrusted = false,
) {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "base\n");
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-qm", "initial"]);
  const fake = await writeFakePi(root);
  const runDir = join(repo, ".pi", "swarm", "runs", runId);
  const plan: any = {
    schemaVersion: 1,
    taskSummary: "controlled parallel",
    strategy: "two workers",
    contracts: [],
    subtasks: [
      { id: "a", title: "a", goal: "a", role: "a", rolePrompt: "a", ownedPaths: ["src/a/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } },
      { id: "b", title: "b", goal: "b", role: "b", rolePrompt: "b", ownedPaths: ["src/b/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [PASS_COMMAND], criteria: [] } },
    ],
    mergeOrder: ["a", "b"],
    risks: [],
  };
  const run: any = { schemaVersion: 1, runId, createdAt: Date.now(), updatedAt: Date.now(), cwd: repo, task: "controlled", phase: "reviewing", plan, planEdits: [], workers: {}, merged: [], conflicts: [], totals: { ...emptyUsage(), wallSec: 0, turns: 0 }, runDir };
  const config = structuredClone(DEFAULT_CONFIG);
  config.run.verify.integrationLight = [];
  config.run.verify.full = [];
  config.run.verifyAllowedPrefixes = ["node -e"];
  config.worker.maxConcurrency = 2;
  const store = new RunStore(join(repo, ".pi", "swarm", "runs"));
  const orchestrator = new Orchestrator({
    run,
    config,
    store,
    agentDir: join(root, "agent"),
    workspace: new WorkspaceManager({ cwd: repo, runId, runDir, worktreesRoot: join(root, "worktrees") }),
    workerFactory: (options) => new WorkerHandle({ ...options, piCommand: process.execPath, piArgsPrefix: [fake], extraEnv: { ...extraEnv, FAKE_PI_DELAY_MS: String(delayMs) } }),
    hooks: { projectTrusted, onUpdate: () => {}, onUi: async (_id, request) => ({ id: request.id, cancelled: true }), onUiBatch, onBudget, onReport: async () => {} },
  });
  return { repo, fake, run, config, store, orchestrator };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function git(cwd: string, args: string[]) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
}
