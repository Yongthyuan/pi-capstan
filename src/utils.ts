import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage<T extends ReturnType<typeof emptyUsage>>(target: T, delta: Partial<T>): T {
  target.input += Number(delta.input ?? 0);
  target.output += Number(delta.output ?? 0);
  target.cacheRead += Number(delta.cacheRead ?? 0);
  target.cacheWrite += Number(delta.cacheWrite ?? 0);
  target.cost += Number(delta.cost ?? 0);
  return target;
}

export function truncateTail(value: string, maxBytes = 8192): string {
  const data = Buffer.from(value);
  if (data.byteLength <= maxBytes) return value;
  return Buffer.concat([Buffer.from("…<truncated>\n"), data.subarray(data.byteLength - maxBytes)]).toString("utf8");
}

export function tokenizeTask(task: string): string[] {
  return Array.from(
    new Set(
      task
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./-]+/u)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2 && part.length <= 48),
    ),
  );
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return overlap / (left.size + right.size - overlap || 1);
}

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index++;
        if (normalized[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

export async function canonicalWriteTarget(target: string, cwd: string): Promise<string> {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  if (await pathExists(absolute)) return realpath(absolute);
  const suffix: string[] = [];
  let cursor = absolute;
  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve write target: ${absolute}`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(await realpath(cursor), ...suffix);
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, options.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function readTextIfPresent(path: string, maxBytes = 64_000): Promise<string> {
  if (!(await pathExists(path))) return "";
  const info = await stat(path);
  if (!info.isFile()) return "";
  const data = await readFile(path);
  return data.subarray(0, maxBytes).toString("utf8");
}
