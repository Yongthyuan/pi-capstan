import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SwarmConfig, Subtask } from "./types.ts";
import { ensurePrivateDir } from "./utils.ts";

export interface GuardOptions {
  runDir: string;
  worktree: string;
  heartbeatFile: string;
  task: Subtask;
  trusted: boolean;
  config: SwarmConfig;
}

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
    ownedPaths: options.task.ownedPaths,
    denylist: options.config.bashDenylist,
    trusted: options.trusted,
  });
  return `import { existsSync, realpathSync, statSync } from "node:fs";
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

export default function(pi: ExtensionAPI) {
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
        console.error("SWARM_VIOLATION " + target);
        return { block: true, reason: "scope violation: " + target };
      }
    }
    if (isToolCallEventType("bash", event) && deny.some((rx: RegExp) => rx.test(event.input.command))) {
      return { block: true, reason: "swarm guard blocked a mutating or dangerous shell command" };
    }
  });
}
`;
}
