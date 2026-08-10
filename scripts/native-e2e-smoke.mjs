import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../src/utils.ts";

const model = process.env.PI_SWARM_TEST_MODEL;
if (!model) throw new Error("PI_SWARM_TEST_MODEL is required");

const root = await mkdtemp(join(tmpdir(), "pi-swarm-e2e-"));
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
  await writeFile(join(repo, "README.md"), "# Native end-to-end smoke\n");
  await writeFile(join(repo, ".pi", "swarm.json"), `${JSON.stringify({
    planner: { timeoutSec: 180, budgetUsd: 5, tokenLimit: 200000 },
    worker: { model, tools: ["read", "write"], maxConcurrency: 2, maxRetries: 0, wallClockMin: 5, perAgentBudgetUsd: 5 },
    run: { budgetUsd: 10, verifyAllowedPrefixes: ["true"], verify: { worker: null, integrationLight: [], full: [] } },
  }, null, 2)}\n`);
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Pi Swarm Test"]);
  await git(["add", "README.md", ".pi/swarm.json"]);
  await git(["commit", "-qm", "initial"]);

  child = spawn(process.env.PI_SWARM_PI_BIN ?? "pi", [
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
    message: "/swarm \"Create alpha.txt containing exactly alpha and beta.txt containing exactly beta as two independent tasks. Each worker owns only its exact file and uses true for acceptance.\" --force",
  });
  if (!prompt.success) throw new Error(`swarm command failed: ${JSON.stringify(prompt)}`);

  const runsRoot = join(repo, ".pi", "swarm", "runs");
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
  const alpha = await git(["show", `${state.git.integrationBranch}:alpha.txt`]);
  const beta = await git(["show", `${state.git.integrationBranch}:beta.txt`]);
  if (alpha !== "alpha" || beta !== "beta") throw new Error(`unexpected files: alpha=${JSON.stringify(alpha)} beta=${JSON.stringify(beta)}`);
  if (!state.gitOperations?.every((operation) => operation.phase === "promoted")) throw new Error("candidate operations were not fully promoted");
  process.stdout.write(`native full /swarm E2E ok: ${model}, workers=${state.plan.subtasks.length}, turns=${state.totals.turns}\n`);
} finally {
  if (child) {
    child.stdin.end();
    await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
}
