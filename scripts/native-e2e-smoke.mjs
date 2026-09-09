import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { nativeScenario } from "./native-scenario.mjs";
import { runCommand } from "../src/utils.ts";

const model = process.env.PI_CAPSTAN_TEST_MODEL;
if (!model) throw new Error("PI_CAPSTAN_TEST_MODEL is required");

if (process.argv.includes("--dry-run")) {
  process.stdout.write(JSON.stringify({ model, caseStore: false, ...nativeScenario }, null, 2) + "\n");
  process.exit(0);
}

const sourceFiles = await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "index.ts", "package.json", "package-lock.json", "scripts/native-e2e-smoke.mjs", "scripts/native-scenario.mjs"], { cwd: resolve(".") });
const sourceDigest = createHash("sha256");
for (const file of [...new Set(sourceFiles.stdout.split("\0").filter(Boolean))].sort()) sourceDigest.update(file + "\0").update(await readFile(resolve(file)));
const source = {
  head: (await runCommand("git", ["rev-parse", "HEAD"], { cwd: resolve(".") })).stdout.trim(),
  contentSha256: sourceDigest.digest("hex"),
  dirty: Boolean((await runCommand("git", ["status", "--porcelain"], { cwd: resolve(".") })).stdout.trim()),
};

const root = await mkdtemp(join(tmpdir(), "pi-capstan-e2e-"));
const repo = join(root, "repo");
const sessions = join(root, "sessions");
await mkdir(join(repo, ".pi"), { recursive: true });
await mkdir(sessions, { recursive: true });

async function git(args) {
  const result = await runCommand("git", args, { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

let child;
try {
  for (const [path, content] of Object.entries(nativeScenario.files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, ".pi", "capstan.json"), `${JSON.stringify({
    gate: { model: null },
    planner: { model: null, timeoutSec: 120, budgetUsd: 0.25, tokenLimit: 16000 },
    worker: { model: null, tools: ["read", "write"], maxConcurrency: 2, maxRetries: 1, wallClockMin: 3, perAgentBudgetUsd: 0.35, setupCommands: [] },
    run: { budgetUsd: 1, verifyAllowedPrefixes: ["node --test", "npm test"], verify: { worker: null, integrationLight: ["npm test"], full: ["npm test"] }, verificationStrategy: null, schedulingStrategy: null, collaborationPrimitives: [] },
    caseStore: { enabled: false },
    safetyGuardPath: null,
  }, null, 2)}\n`);
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Pi Capstan Test"]);
  await git(["add", ...Object.keys(nativeScenario.files), ".pi/capstan.json"]);
  await git(["commit", "-qm", "initial"]);

  const initialHead = await git(["rev-parse", "HEAD"]);
  const initialTests = await runCommand("npm", ["test"], { cwd: repo });
  if (initialTests.exitCode === 0) throw new Error("Synthetic tests must fail before implementation");

  child = spawn(process.env.PI_CAPSTAN_PI_BIN ?? "pi", [
    "--mode", "rpc",
    "--model", model,
    "--session-dir", sessions,
    "--no-tools",
    "--no-extensions",
    "-e", resolve("index.ts"),
    "--approve",
  ], { cwd: repo, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let stderr = "";
  const errors = [];
  const waiters = new Map();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "extension_ui_request") {
        if (event.method === "confirm") child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: true })}\n`);
        else if (["select", "input", "editor"].includes(event.method)) child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
        if (event.method === "notify" && event.notifyType === "error") errors.push(String(event.message ?? "extension error"));
      }
      if (event.id && waiters.has(event.id)) {
        waiters.get(event.id)(event);
        waiters.delete(event.id);
      }
    }
  });
  const request = (payload, timeoutMs = 300_000) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { waiters.delete(payload.id); reject(new Error(`timeout: ${payload.type}\n${stderr.slice(-4000)}`)); }, timeoutMs);
    waiters.set(payload.id, (value) => { clearTimeout(timer); resolvePromise(value); });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
  const prompt = await request({
    id: "e2e",
    type: "prompt",
    message: "/capstan " + JSON.stringify(nativeScenario.task) + " --force",
  });
  if (!prompt.success) throw new Error(`capstan command failed: ${JSON.stringify(prompt)}`);

  const runsRoot = join(repo, ".pi", "capstan", "runs");
  const deadline = Date.now() + 300_000;
  let state;
  while (!state) {
    try {
      for (const id of await readdir(runsRoot)) {
        const candidate = JSON.parse(await readFile(join(runsRoot, id, "state.json"), "utf8"));
        if (["done", "failed", "aborted"].includes(candidate.phase)) state = candidate;
      }
    } catch { /* Run is still starting. */ }
    if (errors.length) throw new Error(errors.join(" | "));
    if (Date.now() > deadline) throw new Error(`E2E state timeout\n${stderr.slice(-4000)}`);
    if (!state) await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  if (state.phase !== "done" || state.outcome !== "branch") throw new Error(`unexpected E2E outcome: ${JSON.stringify(state)}`);
  if (state.partialSuccess || state.merged.length !== 2) throw new Error("Both synthetic tasks must be promoted");
  if (!state.gitOperations?.every((operation) => operation.phase === "promoted" && operation.verification?.ok && !operation.verification.skipped && operation.verification.commands.length)) throw new Error("Candidate operations lack executed verification");
  if (!state.finalVerification?.ok || state.finalVerification.skipped || !state.finalVerification.commands.length) throw new Error("Missing persisted full integration verification");
  for (const worker of Object.values(state.workers)) {
    if (!worker.launch?.model?.startsWith(model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""))) throw new Error("Worker did not inherit the selected Pi model");
  }
  const changed = (await git(["diff", "--name-only", initialHead, state.git.integrationBranch])).split("\n").filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...nativeScenario.expectedSources].sort())) throw new Error("Unexpected changed paths: " + changed.join(", "));
  const landed = join(root, "landed");
  await git(["worktree", "add", "--detach", landed, state.git.integrationBranch]);
  const verified = await runCommand("npm", ["test"], { cwd: landed });
  if (verified.exitCode !== 0) throw new Error("Landed test suite failed: " + verified.stderr);
  if (await git(["rev-parse", "HEAD"]) !== initialHead) throw new Error("Main checkout was modified");
  const summary = {
    capturedAt: new Date().toISOString(), scenario: "two-modules-from-failing-tests", model,
    fixtureSha256: createHash("sha256").update(JSON.stringify(nativeScenario)).digest("hex"),
    source,
    phase: state.phase, outcome: state.outcome, workers: state.plan.subtasks.length,
    turns: state.totals.turns, tokens: state.totals.input + state.totals.output,
    estimatedCostUsd: state.totals.cost, changedFiles: changed,
    initialTestsFailed: true, landedTestsPassed: true,
    finalVerification: state.finalVerification.commands.map(({ command, exitCode }) => ({ command, exitCode })),
    promotions: state.gitOperations.map(({ preMergeSha, postMergeSha, phase }) => ({ preMergeSha, postMergeSha, phase })),
  };
  const artifacts = resolve("scripts/bench/results");
  await mkdir(artifacts, { recursive: true });
  const artifact = join(artifacts, "native-e2e-" + summary.capturedAt.replaceAll(":", "-") + ".json");
  await writeFile(artifact, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write("native full /capstan E2E ok: " + JSON.stringify(summary) + "\nartifact: " + artifact + "\n");

} finally {
  if (child) {
    child.stdin.end();
    await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
}
