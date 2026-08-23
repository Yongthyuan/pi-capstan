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

export class MetricsCollector {
  readonly runId: string;
  private readonly metricsFile: string;

  constructor(runId: string, metricsFile: string) {
    this.runId = runId;
    this.metricsFile = metricsFile;
  }

  async recordWorkerStart(workerId: string, taskId: string): Promise<void> {
    await this.write({ type: "worker_start", ts: Date.now(), workerId, taskId });
  }

  async recordWorkerEnd(
    workerId: string,
    status: "completed" | "failed" | "aborted",
    costUsd: number,
    retries = 0,
  ): Promise<void> {
    await this.write({ type: "worker_end", ts: Date.now(), workerId, status, costUsd, retries });
  }

  async recordMergeAttempt(taskId: string, success: boolean, conflictCount: number, durationMs: number): Promise<void> {
    await this.write({ type: "merge", ts: Date.now(), taskId, success, conflictCount, durationMs });
  }

  async recordVerification(key: string, ok: boolean, durationMs: number): Promise<void> {
    await this.write({ type: "verification", ts: Date.now(), key, ok, durationMs });
  }

  private async write(event: MetricsEvent): Promise<void> {
    await ensurePrivateDir(dirname(this.metricsFile));
    await appendFile(this.metricsFile, `${JSON.stringify(event)}\n`, "utf8");
  }
}
