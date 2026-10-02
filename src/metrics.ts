/**
 * Lightweight metrics collector for a single capstan run.
 * Events are appended to metrics.jsonl for later analysis.
 */

import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./utils.ts";

export type MetricsEvent =
  | { type: "worker_start"; ts: number; workerId: string; taskId: string }
  | { type: "worker_end"; ts: number; workerId: string; status: "completed" | "failed" | "aborted"; costUsd: number; retries: number }
  | { type: "merge"; ts: number; taskId: string; success: boolean; conflictCount: number; durationMs: number }
  | { type: "verification"; ts: number; key: string; ok: boolean; durationMs: number };

export interface MetricsSnapshot {
  avgTaskDuration: number;
  conflictRate: number;
  budgetUtilization: number;
  stalledWorkers: string[];
}

export class MetricsCollector {
  readonly runId: string;
  private readonly metricsFile: string;
  private readonly startedAt = new Map<string, number>();
  private readonly durations: number[] = [];
  private mergeAttempts = 0;
  private mergeConflicts = 0;

  constructor(runId: string, metricsFile: string) {
    this.runId = runId;
    this.metricsFile = metricsFile;
  }

  async recordWorkerStart(workerId: string, taskId: string): Promise<void> {
    this.startedAt.set(workerId, Date.now());
    await this.write({ type: "worker_start", ts: Date.now(), workerId, taskId });
  }

  async recordWorkerEnd(
    workerId: string,
    status: "completed" | "failed" | "aborted",
    costUsd: number,
    retries = 0,
  ): Promise<void> {
    const started = this.startedAt.get(workerId);
    if (started !== undefined) {
      this.durations.push(Math.max(0, Date.now() - started));
      this.startedAt.delete(workerId);
    }
    await this.write({ type: "worker_end", ts: Date.now(), workerId, status, costUsd, retries });
  }

  async recordMergeAttempt(taskId: string, success: boolean, conflictCount: number, durationMs: number): Promise<void> {
    this.mergeAttempts++;
    if (conflictCount > 0 || !success) this.mergeConflicts++;
    await this.write({ type: "merge", ts: Date.now(), taskId, success, conflictCount, durationMs });
  }

  async recordVerification(key: string, ok: boolean, durationMs: number): Promise<void> {
    await this.write({ type: "verification", ts: Date.now(), key, ok, durationMs });
  }

  snapshot(options: { budgetUsd: number; spentUsd: number; stalledWorkers: string[] }): MetricsSnapshot {
    const avgTaskDuration = this.durations.length
      ? this.durations.reduce((sum, value) => sum + value, 0) / this.durations.length
      : 0;
    return {
      avgTaskDuration,
      conflictRate: this.mergeAttempts ? this.mergeConflicts / this.mergeAttempts : 0,
      budgetUtilization: options.budgetUsd > 0 ? Math.max(0, options.spentUsd / options.budgetUsd) : 0,
      stalledWorkers: [...options.stalledWorkers],
    };
  }

  private async write(event: MetricsEvent): Promise<void> {
    await ensurePrivateDir(dirname(this.metricsFile));
    await appendFile(this.metricsFile, `${JSON.stringify(event)}\n`, "utf8");
  }
}
