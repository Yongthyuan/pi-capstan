import { copyFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunPhase, SwarmRun } from "./types.ts";
import { atomicWriteJson, ensurePrivateDir, pathExists } from "./utils.ts";

const TERMINAL_PHASES = new Set<RunPhase>(["done", "aborted", "failed"]);

export class RunStore {
  readonly runsRoot: string;
  readonly diagnostics: string[] = [];

  constructor(runsRoot: string) {
    this.runsRoot = runsRoot;
  }

  runDir(runId: string): string {
    return join(this.runsRoot, runId);
  }

  statePath(runId: string): string {
    return join(this.runDir(runId), "state.json");
  }

  async save(run: SwarmRun): Promise<void> {
    run.updatedAt = Date.now();
    await ensurePrivateDir(run.runDir);
    if (await pathExists(this.statePath(run.runId))) {
      try {
        JSON.parse(await readFile(this.statePath(run.runId), "utf8"));
        await copyFile(this.statePath(run.runId), join(this.runDir(run.runId), "state.prev.json"));
      } catch {
        // Preserve the last known-good backup when the primary is already corrupt.
      }
    }
    await atomicWriteJson(this.statePath(run.runId), run);
  }

  async load(runId: string): Promise<SwarmRun> {
    try {
      return migrateRun(JSON.parse(await readFile(this.statePath(runId), "utf8")));
    } catch (primaryError) {
      const backup = join(this.runDir(runId), "state.prev.json");
      try {
        const recovered = migrateRun(JSON.parse(await readFile(backup, "utf8")));
        this.diagnostics.push(`run ${runId} 已从 state.prev.json 恢复`);
        return recovered;
      } catch {
        throw new Error(`run ${runId} 状态损坏且备份不可用: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
      }
    }
  }

  async list(): Promise<SwarmRun[]> {
    this.diagnostics.length = 0;
    if (!(await pathExists(this.runsRoot))) return [];
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    const runs: SwarmRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        runs.push(await this.load(entry.name));
      } catch (error) {
        this.diagnostics.push(error instanceof Error ? error.message : String(error));
      }
    }
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async unfinished(): Promise<SwarmRun[]> {
    return (await this.list()).filter((run) => !TERMINAL_PHASES.has(run.phase));
  }
}

function migrateRun(value: any): SwarmRun {
  if (!value || typeof value !== "object") throw new Error("state 不是对象");
  if (value.schemaVersion !== 1) throw new Error(`不支持 state schemaVersion ${String(value.schemaVersion)}`);
  if (typeof value.runId !== "string" || typeof value.runDir !== "string") throw new Error("state 缺少 runId/runDir");
  value.planEdits ??= [];
  value.workers ??= {};
  value.merged ??= [];
  value.conflicts ??= [];
  value.gitOperations ??= [];
  value.totals ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, wallSec: 0, turns: 0 };
  for (const worker of Object.values(value.workers) as any[]) {
    worker.pendingUi ??= [];
    worker.scopeViolations ??= [];
    worker.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    worker.turns ??= 0;
  }
  return value as SwarmRun;
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export async function pruneRunArtifacts(runsRoot: string, retention: { logsDays: number; sessionsDays: number }, now = Date.now()): Promise<void> {
  if (!(await pathExists(runsRoot))) return;
  const runs = await readdir(runsRoot, { withFileTypes: true });
  for (const run of runs) {
    if (!run.isDirectory()) continue;
    await pruneChildren(join(runsRoot, run.name, "logs"), now - retention.logsDays * 86_400_000);
    await pruneChildren(join(runsRoot, run.name, "sessions"), now - retention.sessionsDays * 86_400_000);
  }
}

async function pruneChildren(root: string, cutoff: number): Promise<void> {
  if (!(await pathExists(root))) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const modified = await newestMtime(path, entry.isDirectory());
    if (modified < cutoff) await rm(path, { recursive: entry.isDirectory(), force: true });
  }
}

async function newestMtime(path: string, directory: boolean): Promise<number> {
  let newest = (await stat(path)).mtimeMs;
  if (!directory) return newest;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    newest = Math.max(newest, await newestMtime(join(path, entry.name), entry.isDirectory()));
  }
  return newest;
}
