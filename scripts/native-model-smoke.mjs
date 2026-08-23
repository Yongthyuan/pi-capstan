import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { RunStore } from "../src/state.ts";
import { emptyUsage, runCommand } from "../src/utils.ts";
import { WorkspaceManager } from "../src/workspace.ts";

const model = process.env.PI_CAPSTAN_TEST_MODEL;
if (!model) throw new Error("PI_CAPSTAN_TEST_MODEL is required, for example github-copilot-edu/gpt-4o-mini");

const root = await mkdtemp(join(tmpdir(), "pi-capstan-model-"));
const repo = join(root, "repo");
const runId = "native-model";
const runDir = join(repo, ".pi", "capstan", "runs", runId);
await mkdir(repo, { recursive: true });

async function git(args) {
  const result = await runCommand("git", args, { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
  await writeFile(join(repo, "README.md"), "# Native model smoke\n");
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Pi Capstan Test"]);
  await git(["add", "README.md"]);
  await git(["commit", "-qm", "initial"]);

  const plan = {
    schemaVersion: 1,
    taskSummary: "real Pi RPC two-worker canary",
    strategy: "two independent exact-file writes",
    contracts: [],
    subtasks: [
      {
        id: "alpha",
        title: "write alpha marker",
        goal: "Create alpha.txt containing exactly alpha followed by a newline.",
        role: "marker-writer",
        rolePrompt: "Use the write tool to create only alpha.txt with exact content alpha and a trailing newline. Do not modify any other file. Finish with ## Completion Report.",
        ownedPaths: ["alpha.txt"],
        readPaths: ["README.md"],
        dependsOn: [],
        contracts: [],
        acceptance: { commands: ["true"], criteria: ["alpha.txt contains alpha"] },
        model,
      },
      {
        id: "beta",
        title: "write beta marker",
        goal: "Create beta.txt containing exactly beta followed by a newline.",
        role: "marker-writer",
        rolePrompt: "Use the write tool to create only beta.txt with exact content beta and a trailing newline. Do not modify any other file. Finish with ## Completion Report.",
        ownedPaths: ["beta.txt"],
        readPaths: ["README.md"],
        dependsOn: [],
        contracts: [],
        acceptance: { commands: ["true"], criteria: ["beta.txt contains beta"] },
        model,
      },
    ],
    mergeOrder: ["alpha", "beta"],
    risks: [],
  };
  const run = {
    schemaVersion: 1,
    runId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: repo,
    task: "native model smoke",
    phase: "reviewing",
    plan,
    planEdits: [],
    workers: {},
    merged: [],
    conflicts: [],
    totals: { ...emptyUsage(), wallSec: 0, turns: 0 },
    runDir,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.worker.model = model;
  config.worker.tools = ["read", "write"];
  config.worker.maxConcurrency = 2;
  config.worker.maxRetries = 0;
  config.worker.stallSec = 60;
  config.worker.wallClockMin = 5;
  config.run.verifyAllowedPrefixes = ["true"];
  config.run.verify.integrationLight = [];
  config.run.verify.full = [];
  config.run.mergeStrategy = "branch";

  const store = new RunStore(join(repo, ".pi", "capstan", "runs"));
  const orchestrator = new Orchestrator({
    run,
    config,
    store,
    workspace: new WorkspaceManager({ cwd: repo, runId, runDir, worktreesRoot: join(root, "worktrees") }),
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"),
    hooks: {
      projectTrusted: false,
      onUpdate: () => {},
      onUi: async (_id, request) => ({ id: request.id, cancelled: true }),
      onBudget: async () => "stop",
      onReport: async () => {},
    },
  });
  await orchestrator.execute(false);
  if (run.phase !== "done") throw new Error(`native model run failed: ${run.error ?? run.phase}`);
  const branch = `capstan/${runId}/integration`;
  const alpha = await git(["show", `${branch}:alpha.txt`]);
  const beta = await git(["show", `${branch}:beta.txt`]);
  if (alpha !== "alpha" || beta !== "beta") throw new Error(`unexpected branch contents: alpha=${JSON.stringify(alpha)} beta=${JSON.stringify(beta)}`);
  process.stdout.write(`native provider-backed capstan ok: ${model}, turns=${run.totals.turns}, tokens=${run.totals.input + run.totals.output}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
