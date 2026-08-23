import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../src/utils.ts";

const model = process.env.PI_CAPSTAN_TEST_MODEL;
if (!model) throw new Error("PI_CAPSTAN_TEST_MODEL is required");

const root = await mkdtemp(join(tmpdir(), "pi-capstan-plan-"));
const repo = join(root, "repo");
const sessions = join(root, "sessions");
await mkdir(repo, { recursive: true });
await mkdir(sessions, { recursive: true });

async function git(args) {
  const result = await runCommand("git", args, { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

let child;
try {
  await writeFile(join(repo, "README.md"), "# Planner smoke\n\nThe repository intentionally has two independent requested marker files.\n");
  await mkdir(join(repo, ".pi"), { recursive: true });
  await writeFile(join(repo, ".pi", "capstan.json"), `${JSON.stringify({ run: { verifyAllowedPrefixes: ["true"] } }, null, 2)}\n`);
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Pi Capstan Test"]);
  await git(["add", "README.md", ".pi/capstan.json"]);
  await git(["commit", "-qm", "initial"]);

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
  const eventTail = [];
  const extensionErrors = [];
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
      eventTail.push(event.type ?? event.command ?? "unknown");
      if (eventTail.length > 80) eventTail.shift();
      if (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error") extensionErrors.push(String(event.message ?? "extension error"));
      if (event.id && waiters.has(event.id)) {
        waiters.get(event.id)(event);
        waiters.delete(event.id);
      }
    }
  });
  const request = (payload, timeoutMs = 180_000) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { waiters.delete(payload.id); reject(new Error(`timeout: ${payload.type}\n${stderr.slice(-4000)}`)); }, timeoutMs);
    waiters.set(payload.id, (value) => { clearTimeout(timer); resolvePromise(value); });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
  const commands = await request({ id: "commands", type: "get_commands" });
  if (!commands.success || !commands.data.commands.some((item) => item.name === "capstan")) throw new Error("capstan command was not registered");
  const prompt = await request({
    id: "plan",
    type: "prompt",
    message: "/capstan \"Create alpha.txt and beta.txt as two fully independent worker tasks. Each task owns only its exact file and uses true as its acceptance command.\" --force --plan-only",
  });
  if (!prompt.success) throw new Error(`plan command failed: ${JSON.stringify(prompt)}`);

  const runsRoot = join(repo, ".pi", "capstan", "runs");
  const deadline = Date.now() + 120_000;
  let state;
  while (!state) {
    try {
      const ids = await readdir(runsRoot);
      for (const id of ids) {
        const candidate = JSON.parse(await readFile(join(runsRoot, id, "state.json"), "utf8"));
        if (candidate.phase === "done") state = candidate;
      }
    } catch {
      // Planner may still be running.
    }
    if (extensionErrors.length) throw new Error(`planner extension error: ${extensionErrors.join(" | ")}`);
    if (state) break;
    if (Date.now() > deadline) throw new Error(`planner state timeout; events=${eventTail.join(",")}\n${stderr.slice(-4000)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (state.outcome !== "planned" || state.plan?.subtasks?.length !== 2) throw new Error(`unexpected planner state: ${JSON.stringify(state)}`);
  process.stdout.write(`native provider-backed planner ok: ${model}, subtasks=${state.plan.subtasks.length}\n`);
} finally {
  if (child) {
    child.stdin.end();
    await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
}
