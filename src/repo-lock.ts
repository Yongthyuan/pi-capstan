import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { processMarker, processMatches } from "./process-identity.ts";
import { pathExists, runCommand } from "./utils.ts";

interface LockOwner {
  schemaVersion: 1;
  token: string;
  runId: string;
  pid: number;
  pidMarker?: string;
  createdAt: number;
  heartbeatAt: number;
}

export class RepoLock {
  readonly repoRoot: string;
  readonly runId: string;
  readonly lockDir: string;
  readonly ownerPath: string;
  readonly token = randomUUID();
  private owner?: LockOwner;
  private heartbeat?: ReturnType<typeof setInterval>;

  private constructor(repoRoot: string, runId: string, lockDir: string) {
    this.repoRoot = repoRoot;
    this.runId = runId;
    this.lockDir = lockDir;
    this.ownerPath = join(lockDir, "owner.json");
  }

  static async forRepo(repoRoot: string, runId: string): Promise<RepoLock> {
    const common = await runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, timeoutMs: 10_000 });
    if (common.exitCode !== 0) throw new Error("仓库锁要求有效 Git 仓库");
    const commonDir = isAbsolute(common.stdout.trim()) ? common.stdout.trim() : join(repoRoot, common.stdout.trim());
    return new RepoLock(repoRoot, runId, join(commonDir, "pi-swarm.lock"));
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.lockDir), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(this.lockDir, { mode: 0o700 });
        const now = Date.now();
        this.owner = {
          schemaVersion: 1,
          token: this.token,
          runId: this.runId,
          pid: process.pid,
          pidMarker: await processMarker(process.pid),
          createdAt: now,
          heartbeatAt: now,
        };
        await this.writeOwner();
        this.heartbeat = setInterval(() => void this.beat(), 10_000);
        this.heartbeat.unref();
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await this.readOwner();
        if (existing && await processMatches(existing.pid, existing.pidMarker)) {
          throw new Error(`仓库已有活跃 swarm run ${existing.runId} (pid ${existing.pid})`);
        }
        if (!existing) {
          const age = Date.now() - (await stat(this.lockDir)).mtimeMs;
          if (age < 60_000) throw new Error("仓库 swarm 锁正在初始化，请稍后重试");
        }
        const stale = `${this.lockDir}.stale-${randomUUID()}`;
        try { await rename(this.lockDir, stale); } catch (renameError: any) {
          if (renameError?.code === "ENOENT") continue;
          throw renameError;
        }
        await rm(stale, { recursive: true, force: true });
      }
    }
    throw new Error("无法取得仓库 swarm 锁");
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const existing = await this.readOwner();
    if (existing?.token === this.token) await rm(this.lockDir, { recursive: true, force: true });
    this.owner = undefined;
  }

  private async beat(): Promise<void> {
    if (!this.owner) return;
    const existing = await this.readOwner();
    if (existing?.token !== this.token) {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      return;
    }
    this.owner.heartbeatAt = Date.now();
    await this.writeOwner().catch(() => undefined);
  }

  private async writeOwner(): Promise<void> {
    if (!this.owner) return;
    await writeFile(this.ownerPath, `${JSON.stringify(this.owner, null, 2)}\n`, { mode: 0o600 });
  }

  private async readOwner(): Promise<LockOwner | undefined> {
    if (!(await pathExists(this.ownerPath))) return undefined;
    try { return JSON.parse(await readFile(this.ownerPath, "utf8")) as LockOwner; } catch { return undefined; }
  }
}
