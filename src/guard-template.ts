import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapstanConfig, Subtask } from "./types.ts";
import { ensurePrivateDir } from "./utils.ts";

export interface GuardOptions {
  runDir: string;
  worktree: string;
  heartbeatFile: string;
  task: Subtask;
  trusted: boolean;
  config: CapstanConfig;
  peers?: string[];
}

// Opt-in patterns closing the interpreter escape: the base denylist blocks
// redirects and mutating commands, but inline code (python -c, node -e, ...)
// can write anywhere. Off by default because it also blocks legitimate
// read-only one-liners; tighten via worker.strictBash when the trade-off fits.
export const STRICT_BASH_DENYLIST = [
  "\\bpython[0-9.]*\\b[^\\n]*\\s-c\\b",
  "\\b(?:ruby|perl)\\b[^\\n]*\\s-[eE]\\b",
  "\\bphp\\b[^\\n]*\\s-r\\b",
  "\\b(?:node|deno|bun)\\b[^\\n]*\\s(?:-e|--eval|-p|--print)\\b",
  "\\b(?:sh|bash|zsh|dash|ksh|fish)\\b[^\\n]*\\s-c\\b",
  "\\bfind\\b[^\\n]*\\s-(?:delete|exec|execdir|ok|okdir)\\b",
];

export async function writeGuardExtension(options: GuardOptions): Promise<string> {
  const guardDir = join(options.runDir, "guard");
  await ensurePrivateDir(guardDir);
  const path = join(guardDir, `${options.task.id}.ts`);
  const source = buildGuardSource(options);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

export function buildGuardSource(options: GuardOptions): string {
  const payload = JSON.stringify({
    worktree: options.worktree,
    heartbeatFile: options.heartbeatFile,
    ownedPaths: [...options.task.ownedPaths, ...(options.task.sharedPaths ?? []), ...(options.task.generatedPaths ?? []), ...options.config.worker.scopeAllowlist],
    denylist: [...options.config.bashDenylist, ...(options.config.worker.strictBash ? STRICT_BASH_DENYLIST : [])],
    trusted: options.trusted,
    taskId: options.task.id,
    peers: options.peers ?? [],
    mailboxDir: join(options.runDir, "mailbox"),
  });
  return `import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
	import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const cfg = ${payload};
const root = realpathSync(cfg.worktree);
const deny = cfg.denylist.map((value: string) => new RegExp(value, "i"));
let heartbeat: ReturnType<typeof setInterval> | undefined;

function globRx(glob: string): RegExp {
  const value = glob.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
  let out = "^";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "*") {
      if (value[i + 1] === "*") { i++; if (value[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*"; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[|\\\\{}()[\\]^$+?.]/g, "\\\\$&");
  }
  return new RegExp(out + "$");
}
const owned = cfg.ownedPaths.map(globRx);

function canonical(path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (existsSync(abs)) return realpathSync(abs);
  const suffix: string[] = [];
  let cursor = abs;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("cannot resolve write target: " + abs);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function scoped(path: string): { target: string; rel: string } {
  const target = canonical(path);
  const rel = relative(root, target).replaceAll("\\\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !owned.some((rx: RegExp) => rx.test(rel))) {
    throw new Error("scope violation: " + target);
  }
  return { target, rel };
}

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false }) as any;
const stringSchema = { type: "string" };

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "capstan_send",
    label: "Send Capstan Message",
    description: "Send a concise coordination message to a peer worker in this run.",
    parameters: objectSchema({ to: { type: "string", enum: cfg.peers }, message: stringSchema }, ["to", "message"]),
    async execute(_id: string, input: { to: string; message: string }) {
      if (!cfg.peers.includes(input.to) || input.to === cfg.taskId) return { content: [{ type: "text", text: "invalid peer" }], isError: true };
      const message = String(input.message ?? "").slice(0, 4000);
      if (!message.trim()) return { content: [{ type: "text", text: "empty message" }], isError: true };
      mkdirSync(cfg.mailboxDir, { recursive: true, mode: 0o700 });
      appendFileSync(resolve(cfg.mailboxDir, input.to + ".jsonl"), JSON.stringify({ from: cfg.taskId, to: input.to, message, ts: Date.now() }) + "\\n", { mode: 0o600 });
      return { content: [{ type: "text", text: "message queued for " + input.to }] };
    },
  } as any);
  pi.registerTool({
    name: "capstan_inbox",
    label: "Read Capstan Inbox",
    description: "Read recent messages from peer workers.",
    parameters: objectSchema({}, []),
    async execute() {
      const path = resolve(cfg.mailboxDir, cfg.taskId + ".jsonl");
      const lines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\\n").filter(Boolean).slice(-50) : [];
      return { content: [{ type: "text", text: lines.length ? lines.join("\\n") : "inbox empty" }] };
    },
  } as any);
  pi.registerTool({
    name: "capstan_fs",
    label: "Scoped Filesystem Operation",
    description: "Perform mkdir, touch, remove, move, or copy inside owned paths without shell mutation.",
    parameters: objectSchema({ operation: { type: "string", enum: ["mkdir", "touch", "remove", "move", "copy"] }, path: stringSchema, destination: stringSchema }, ["operation", "path"]),
    async execute(_id: string, input: { operation: string; path: string; destination?: string }) {
      try {
        const source = scoped(input.path);
        if (input.operation === "mkdir") mkdirSync(source.target, { recursive: true });
        else if (input.operation === "touch") { mkdirSync(dirname(source.target), { recursive: true }); writeFileSync(source.target, existsSync(source.target) ? readFileSync(source.target) : ""); }
        else if (input.operation === "remove") rmSync(source.target, { recursive: true, force: true });
        else {
          if (!input.destination) throw new Error("destination is required");
          const destination = scoped(input.destination);
          mkdirSync(dirname(destination.target), { recursive: true });
          if (input.operation === "move") renameSync(source.target, destination.target);
          else if (input.operation === "copy") cpSync(source.target, destination.target, { recursive: true, force: false });
          else throw new Error("unsupported operation");
        }
        return { content: [{ type: "text", text: input.operation + " completed for " + source.rel }] };
      } catch (error) {
        console.error("CAPSTAN_VIOLATION " + String(error));
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  } as any);
  pi.on("project_trust", () => ({ trusted: cfg.trusted ? "yes" : "no" }));
  pi.on("session_start", () => {
    heartbeat = setInterval(() => {
      try { if (Date.now() - statSync(cfg.heartbeatFile).mtimeMs > 45_000) process.exit(75); }
      catch { process.exit(75); }
    }, 15_000);
    heartbeat.unref();
  });
  pi.on("session_shutdown", () => { if (heartbeat) clearInterval(heartbeat); });
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const target = canonical(event.input.path);
      const rel = relative(root, target).replaceAll("\\\\", "/");
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !owned.some((rx: RegExp) => rx.test(rel))) {
        console.error("CAPSTAN_VIOLATION " + target);
        return { block: true, reason: "scope violation: " + target };
      }
    }
    if (isToolCallEventType("bash", event) && deny.some((rx: RegExp) => rx.test(event.input.command))) {
      return { block: true, reason: "capstan guard blocked a mutating or dangerous shell command" };
    }
  });
}
`;
}
