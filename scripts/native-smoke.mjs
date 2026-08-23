import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { writeGuardExtension } from "../src/guard-template.ts";
import { WorkerHandle } from "../src/worker.ts";

const root = await mkdtemp(join(tmpdir(), "pi-capstan-native-"));
const agentDir = join(root, "agent");
const sessions = join(root, "sessions");
await mkdir(agentDir, { recursive: true });
await mkdir(sessions, { recursive: true });
await mkdir(join(agentDir, "extensions"), { recursive: true });
await symlink(process.cwd(), join(agentDir, "extensions", "capstan"), process.platform === "win32" ? "junction" : "dir");

const piCli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const child = spawn(process.execPath, [
  piCli,
  "--mode", "rpc",
  "--offline",
  "--session-dir", sessions,
  "--no-tools",
  "--no-approve",
], {
  cwd: process.cwd(),
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
const waiters = new Map();
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (stderr += chunk));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.id && waiters.has(event.id)) {
      waiters.get(event.id)(event);
      waiters.delete(event.id);
    }
  }
});

function request(payload, timeoutMs = 15_000) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { waiters.delete(payload.id); reject(new Error(`timeout: ${payload.type}\n${stderr}`)); }, timeoutMs);
    waiters.set(payload.id, (value) => { clearTimeout(timer); resolvePromise(value); });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

try {
  const commands = await request({ id: "commands", type: "get_commands" });
  if (!commands.success || !commands.data.commands.some((item) => item.name === "capstan")) throw new Error(`capstan command not registered: ${JSON.stringify(commands)}`);
  const status = await request({ id: "status", type: "prompt", message: "/capstan status" });
  if (!status.success) throw new Error(`capstan command failed: ${JSON.stringify(status)}`);
  const worktree = join(root, "worker-tree");
  const runDir = join(root, "worker-run");
  await mkdir(worktree, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "heartbeat"), String(Date.now()));
  const task = { id: "native-worker", title: "native worker", goal: "smoke", role: "smoke", rolePrompt: "smoke", ownedPaths: ["**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [], criteria: [] } };
  const workerConfig = structuredClone(DEFAULT_CONFIG);
  const guardPath = await writeGuardExtension({ runDir, worktree, heartbeatFile: join(runDir, "heartbeat"), task, trusted: false, config: workerConfig, peers: ["peer-worker"] });
  const promptPath = join(runDir, "prompt.md");
  await writeFile(promptPath, "Native worker smoke test.");
  const worker = new WorkerHandle({
    id: "native-worker",
    title: "native worker",
    worktree,
    runDir,
    guardPath,
    promptPath,
    sessionDir: join(runDir, "sessions"),
    tools: workerConfig.worker.tools,
    projectTrusted: false,
    piCommand: process.execPath,
    piArgsPrefix: [piCli],
    extraEnv: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
  });
  await worker.start();
  if (!worker.sessionFile) throw new Error("native worker did not return a session file");
  await worker.stop(50);
  process.stdout.write("native pi auto-discovery and guarded worker RPC startup ok\n");
} finally {
  child.stdin.end();
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  await rm(root, { recursive: true, force: true });
}
