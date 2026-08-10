import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { VerificationCommandResult, VerificationResult } from "./types.ts";
import { pathExists, truncateTail } from "./utils.ts";

export interface VerificationOptions {
  signal?: AbortSignal;
  allowedPrefixes?: string[];
}

interface PreparedCommand {
  executable: string;
  args: string[];
}

const SHELL_SYNTAX = /[;&|<>`\r\n]|\$\(|\$\{/;

export async function verifyCommands(commands: string[], cwd: string, timeoutSec: number, options: VerificationOptions = {}): Promise<VerificationResult> {
  const results: VerificationCommandResult[] = [];
  const allowedPrefixes = options.allowedPrefixes ?? [];
  for (const command of commands) {
    if (options.signal?.aborted) break;
    let prepared: PreparedCommand;
    try {
      prepared = prepareVerificationCommand(command, cwd, allowedPrefixes);
    } catch (error) {
      results.push({
        command,
        exitCode: 126,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        timedOut: false,
        blocked: true,
      });
      break;
    }
    const result = await runPrepared(command, prepared, cwd, timeoutSec * 1000, options.signal);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return { ok: results.length === commands.length && results.every((result) => result.exitCode === 0), commands: results };
}

export function isStructurallySafeVerificationCommand(command: string): boolean {
  if (!command.trim() || SHELL_SYNTAX.test(command)) return false;
  try {
    return tokenizeCommand(command).length > 0;
  } catch {
    return false;
  }
}

export async function detectVerificationCommands(cwd: string, full: boolean): Promise<string[]> {
  const packagePath = join(cwd, "package.json");
  if (await pathExists(packagePath)) {
    try {
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const commands: string[] = [];
      if (scripts.typecheck) commands.push("npm run typecheck");
      else if (await pathExists(join(cwd, "node_modules", ".bin", "tsc"))) commands.push("./node_modules/.bin/tsc --noEmit");
      if (scripts.build) commands.push("npm run build");
      if (full && scripts.test) commands.push("npm test");
      if (commands.length) return commands;
    } catch {
      // Fall through to other detectors.
    }
  }
  if (await pathExists(join(cwd, "pyproject.toml")) || await pathExists(join(cwd, "pytest.ini"))) return ["python -m pytest"];
  if (await pathExists(join(cwd, "Cargo.toml"))) return full ? ["cargo test"] : ["cargo check"];
  if (await pathExists(join(cwd, "go.mod"))) return full ? ["go test ./..."] : ["go build ./..."];
  return [];
}

function prepareVerificationCommand(command: string, cwd: string, allowedPrefixes: string[]): PreparedCommand {
  if (!isStructurallySafeVerificationCommand(command)) {
    throw new Error("verification command blocked: shell operators, redirections, substitutions, and multiline commands are not allowed");
  }
  const tokens = tokenizeCommand(command);
  const normalized = tokens.join(" ");
  const permitted = allowedPrefixes.some((prefix) => {
    const clean = tokenizeCommand(prefix).join(" ");
    return normalized === clean || normalized.startsWith(`${clean} `);
  });
  if (!permitted) throw new Error(`verification command blocked by allowlist: ${tokens[0]}`);
  const executable = tokens[0]!;
  if (executable.includes("/")) {
    const absolute = resolve(cwd, executable);
    const rel = relative(resolve(cwd), absolute);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("verification executable must stay inside the worktree");
  }
  return { executable, args: tokens.slice(1) };
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current), (current = "");
    } else {
      current += char;
    }
  }
  if (escaped || quote) throw new Error("unterminated quote or escape in verification command");
  if (current) tokens.push(current);
  return tokens;
}

function runPrepared(display: string, prepared: PreparedCommand, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<VerificationCommandResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(prepared.executable, prepared.args, { cwd, env: verificationEnvironment(), stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout = truncateTail(stdout + chunk, 64_000)));
    child.stderr.on("data", (chunk) => (stderr = truncateTail(stderr + chunk, 64_000)));
    const stop = () => {
      if (!child.pid) return;
      signalProcess(child.pid, "SIGTERM");
      forceTimer ??= setTimeout(() => child.pid && signalProcess(child.pid, "SIGKILL"), 2_000);
      forceTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => { aborted = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      stderr = truncateTail(`${stderr}\n${error.message}`, 64_000);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({ command: display, exitCode: code ?? (aborted ? 130 : 1), stdout, stderr, durationMs: Date.now() - started, timedOut, aborted });
    });
  });
}

function verificationEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|COOKIE|CREDENTIAL|PRIVATE_?KEY)/i.test(key)) continue;
    env[key] = value;
  }
  env.CI ??= "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* Already exited. */ } }
}

export function verificationFailurePrompt(result: VerificationResult, attempt: number, max: number): string {
  const failed = result.commands.find((command) => command.exitCode !== 0);
  if (!failed) return `Verification did not complete (attempt ${attempt}/${max}). Inspect the project and finish the task.`;
  return `Verification failed (attempt ${attempt}/${max}).\nCommand: ${failed.command}\nExit: ${failed.exitCode}${failed.timedOut ? " (timeout)" : ""}${failed.blocked ? " (blocked by policy)" : ""}\nOutput tail:\n${truncateTail(`${failed.stdout}\n${failed.stderr}`, 8_000)}\nFix the failure within your owned paths. If another task owns the necessary change, report it instead of crossing scope.`;
}
