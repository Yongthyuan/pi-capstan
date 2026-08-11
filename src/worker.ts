import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { appendFile } from "node:fs/promises";
import type { PendingUiRequest, UsageTotals, WorkerEventMap } from "./types.ts";
import { emptyUsage, ensurePrivateDir, runCommand, truncateTail } from "./utils.ts";
import { processMarker } from "./process-identity.ts";

export interface WorkerHandleOptions {
  id: string;
  title: string;
  worktree: string;
  runDir: string;
  guardPath: string;
  promptPath: string;
  sessionDir: string;
  sessionFile?: string;
  model?: string | null;
  tools: string[];
  projectTrusted: boolean;
  safetyGuardPath?: string | null;
  piCommand?: string;
  piArgsPrefix?: string[];
  extraEnv?: NodeJS.ProcessEnv;
}

type EventName = keyof WorkerEventMap;

export class WorkerHandle {
  readonly options: WorkerHandleOptions;
  readonly usage: UsageTotals = emptyUsage();
  turns = 0;
  sessionFile?: string;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrTail = "";
  private sequence = 0;
  private readonly emitter = new EventEmitter();
  private readonly responses = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private settledWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private logPath: string;
  private logChain: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(options: WorkerHandleOptions) {
    this.options = options;
    this.sessionFile = options.sessionFile;
    this.logPath = join(options.runDir, "logs", `${options.id}.jsonl`);
  }

  on<K extends EventName>(event: K, listener: (payload: WorkerEventMap[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    await ensurePrivateDir(dirname(this.logPath));
    await ensurePrivateDir(this.options.sessionDir);
    const command = this.options.piCommand ?? process.env.PI_SWARM_PI_BIN ?? "pi";
    const args = [...(this.options.piArgsPrefix ?? []), "--mode", "rpc", "--session-dir", this.options.sessionDir, "--no-extensions"];
    if (this.options.sessionFile && await fileExists(this.options.sessionFile)) args.push("--session", this.options.sessionFile);
    else args.push("--name", `swarm/${this.options.id} ${this.options.title}`);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.tools.length) args.push("--tools", this.options.tools.join(","));
    args.push("--append-system-prompt", this.options.promptPath);
    if (this.options.safetyGuardPath) args.push("-e", this.options.safetyGuardPath);
    args.push("-e", this.options.guardPath, this.options.projectTrusted ? "--approve" : "--no-approve");
    const child = spawn(command, args, {
      cwd: this.options.worktree,
      env: { ...process.env, ...this.options.extraEnv, PI_SWARM_WORKER: "1", PI_SWARM_RUN_DIR: this.options.runDir },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));
    child.on("error", (error) => {
      this.failAll(error);
      if (this.child === child) this.child = undefined;
    });
    child.on("exit", (code) => {
      if (this.stopping) {
        this.finishStopped();
        this.emitter.emit("exit", { code: code ?? 0, stderr: this.stderrTail });
        this.child = undefined;
        return;
      }
      const error = code === 0 ? undefined : new Error(`worker exited ${code}: ${truncateTail(this.stderrTail, 2000)}`);
      this.failAll(error ?? new Error("worker exited"));
      this.emitter.emit("exit", { code: code ?? 1, stderr: this.stderrTail });
      this.child = undefined;
    });
    try {
      const state = (await this.request("get_state", {}, 20_000)) as { sessionFile?: string; sessionId?: string; pidMarker?: string };
      this.sessionFile = state.sessionFile;
      if (child.pid) state.pidMarker = await processMarker(child.pid);
      this.emitter.emit("state", state);
    } catch (error) {
      await this.stop(100).catch(() => undefined);
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  async prompt(message: string, timeoutMs: number): Promise<void> {
    await this.start();
    const settled = this.createSettledWaiter(timeoutMs);
    try {
      await this.request("prompt", { message }, 30_000);
      await settled.promise;
    } catch (error) {
      settled.cancel();
      throw error;
    }
  }

  async steer(message: string): Promise<void> {
    await this.request("steer", { message }, 20_000);
  }

  async abort(): Promise<void> {
    if (!this.child) return;
    await this.request("abort", {}, 20_000).catch(() => undefined);
  }

  respondUi(response: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error("worker stdin 不可写");
    this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
  }

  async stop(graceMs = 2_000): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.stopping = true;
    await this.abort().catch(() => undefined);
    const pid = child.pid;
    if (process.platform === "win32") {
      // Windows has no process-group SIGTERM equivalent. The RPC abort above is
      // the graceful phase; taskkill is the bounded tree cleanup phase. Wait for
      // the child exit event before callers remove its worktree or temp files.
      await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 5_000 }).catch(() => undefined);
      await waitForChildExit(child, Math.max(graceMs, 2_000));
      await this.logChain.catch(() => undefined);
      return;
    }
    signalProcess(pid, "SIGTERM");
    await waitForChildExit(child, graceMs);
    if (this.child?.pid === pid) signalProcess(pid, "SIGKILL");
    await waitForChildExit(child, 2_000);
    await this.logChain.catch(() => undefined);
  }

  private request(type: string, data: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("worker 未运行"));
    const id = `${this.options.id}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`RPC ${type} timeout`));
      }, timeoutMs);
      this.responses.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`, (error) => {
        if (!error) return;
        const pending = this.responses.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.responses.delete(id);
        pending.reject(error);
      });
    });
  }

  private createSettledWaiter(timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
    let record: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settledWaiters = this.settledWaiters.filter((item) => item.timer !== timer);
        reject(new Error(`worker wall-clock timeout after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      record = { resolve, reject, timer };
      this.settledWaiters.push(record);
    });
    return {
      promise,
      cancel: () => {
        if (!record!) return;
        clearTimeout(record.timer);
        this.settledWaiters = this.settledWaiters.filter((item) => item !== record);
      },
    };
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.processLine(line);
    }
  }

  private processLine(line: string): void {
    const safeLine = sanitizeRpcLogLine(line);
    this.logChain = this.logChain.then(
      () => appendFile(this.logPath, `${safeLine}\n`, { mode: 0o600 }),
      () => appendFile(this.logPath, `${safeLine}\n`, { mode: 0o600 }),
    ).catch((error) => {
      this.stderrTail = truncateTail(`${this.stderrTail}\nlog append failed: ${String(error)}`);
    });
    let event: Record<string, any>;
    try {
      event = JSON.parse(line) as Record<string, any>;
    } catch {
      this.stderrTail = truncateTail(`${this.stderrTail}\ninvalid RPC JSON: ${line}`);
      return;
    }
    if (event.type === "response" && event.id) {
      const pending = this.responses.get(event.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.responses.delete(event.id);
        if (event.success) pending.resolve(event.data ?? {});
        else pending.reject(new Error(String(event.error ?? `${event.command} failed`)));
      }
      return;
    }
    if (event.type === "extension_ui_request") {
      this.emitter.emit("ui", { request: event as PendingUiRequest });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.emitter.emit("tool", { active: true, name: String(event.toolName ?? "") });
      this.emitter.emit("action", { label: formatToolAction(event.toolName, event.args ?? event.input ?? {}) });
      return;
    }
    if (event.type === "tool_execution_end") {
      this.emitter.emit("tool", { active: false, name: String(event.toolName ?? "") });
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractText(event.message.content);
      if (text) this.emitter.emit("text", { text });
      const usage = normalizeUsage(event.message.usage);
      this.usage.input += usage.input;
      this.usage.output += usage.output;
      this.usage.cacheRead += usage.cacheRead;
      this.usage.cacheWrite += usage.cacheWrite;
      this.usage.cost += usage.cost;
      this.turns++;
      this.emitter.emit("usage", { usage: { ...this.usage }, turns: this.turns });
      return;
    }
    if (event.type === "auto_retry_start") {
      this.emitter.emit("retrying", { attempt: Number(event.attempt ?? 1), maxAttempts: Number(event.maxAttempts ?? 0) });
      return;
    }
    if (event.type === "agent_settled") {
      this.emitter.emit("tool", { active: false, reset: true });
      const waiters = this.settledWaiters.splice(0);
      for (const waiter of waiters) clearTimeout(waiter.timer), waiter.resolve();
      this.emitter.emit("settled", {});
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrTail = truncateTail(this.stderrTail + chunk, 16_000);
    for (const line of chunk.split("\n")) {
      if (line.startsWith("SWARM_VIOLATION ")) this.emitter.emit("action", { label: `⚠ ${line.slice(16)}` });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.responses.values()) clearTimeout(pending.timer), pending.reject(error);
    this.responses.clear();
    for (const waiter of this.settledWaiters) clearTimeout(waiter.timer), waiter.reject(error);
    this.settledWaiters = [];
  }

  private finishStopped(): void {
    for (const pending of this.responses.values()) clearTimeout(pending.timer), pending.resolve({});
    this.responses.clear();
    for (const waiter of this.settledWaiters) clearTimeout(waiter.timer), waiter.resolve();
    this.settledWaiters = [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
      killer.unref();
      return;
    } catch { /* Fall back to process.kill below. */ }
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item && typeof item === "object" && (item as any).type === "text").map((item) => String((item as any).text ?? "")).join("\n");
}

function normalizeUsage(usage: any): UsageTotals {
  return {
    input: Number(usage?.input ?? usage?.inputTokens ?? 0),
    output: Number(usage?.output ?? usage?.outputTokens ?? 0),
    cacheRead: Number(usage?.cacheRead ?? usage?.cacheReadTokens ?? 0),
    cacheWrite: Number(usage?.cacheWrite ?? usage?.cacheWriteTokens ?? 0),
    cost: Number(usage?.cost?.total ?? usage?.cost ?? 0),
  };
}

function formatToolAction(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return `$ ${String(args.command ?? "").slice(0, 80)}`;
  const path = String(args.path ?? args.file_path ?? "");
  return path ? `${name} ${path}` : name;
}

export function sanitizeRpcLogLine(line: string): string {
  let event: Record<string, any>;
  try { event = JSON.parse(line) as Record<string, any>; } catch { return JSON.stringify({ type: "invalid_rpc_json", bytes: Buffer.byteLength(line) }); }
  if (event.type === "response") {
    return JSON.stringify({ type: event.type, id: event.id, command: event.command, success: event.success, error: redactValue(event.error) });
  }
  if (event.type === "tool_execution_start") {
    const args = event.args ?? event.input ?? {};
    return JSON.stringify({ type: event.type, toolName: event.toolName, path: args.path ?? args.file_path });
  }
  if (event.type === "message_end") {
    return JSON.stringify({ type: event.type, role: event.message?.role, usage: event.message?.usage, stopReason: event.message?.stopReason });
  }
  if (event.type === "extension_ui_request") {
    return JSON.stringify({ type: event.type, id: event.id, method: event.method, title: redactValue(event.title) });
  }
  return JSON.stringify(redactRecord(event));
}

function redactRecord(value: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|secret|password|authorization|cookie|api.?key|credential|prefill|content|prompt|message|args|input|env)/i.test(key)) result[key] = "[redacted]";
    else if (Array.isArray(item)) result[key] = item.map((entry) => typeof entry === "object" && entry ? redactRecord(entry) : redactValue(entry));
    else if (typeof item === "object" && item) result[key] = redactRecord(item);
    else result[key] = redactValue(item);
  }
  return result;
}

function redactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[redacted]");
}
