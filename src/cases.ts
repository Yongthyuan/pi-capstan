import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaseRecord, SwarmPlan, SwarmRun } from "./types.ts";
import { atomicWriteJson, ensurePrivateDir, jaccard, makeRunId, pathExists, tokenizeTask } from "./utils.ts";
import type { RepoBrief } from "./planner.ts";

export class CaseStore {
  readonly root: string;
  readonly max: number;
  readonly threshold: number;
  readonly matcher: "lexical" | "hybrid";

  constructor(root: string, max: number, threshold: number, matcher: "lexical" | "hybrid" = "hybrid") {
    this.root = root;
    this.max = max;
    this.threshold = threshold;
    this.matcher = matcher;
  }

  async list(): Promise<CaseRecord[]> {
    if (!(await pathExists(this.root))) return [];
    const files = (await readdir(this.root)).filter((file) => file.endsWith(".json") && file !== "index.json");
    const records: CaseRecord[] = [];
    for (const file of files) {
      try {
        records.push(JSON.parse(await readFile(join(this.root, file), "utf8")) as CaseRecord);
      } catch {
        // Corrupt records remain inspectable on disk but do not poison matching.
      }
    }
    return records.sort((a, b) => b.ts - a.ts);
  }

  async match(task: string, brief: RepoBrief, limit = 3): Promise<CaseRecord[]> {
    const tags = tokenizeTask(redactTask(task));
    const candidates = (await this.list()).map((record) => {
      const lexical = jaccard(tags, record.taskTags);
      const phrase = trigramSimilarity(redactTask(task), record.taskText);
      const stack = jaccard([...brief.languages, ...brief.frameworks], [...record.repoFingerprint.langs, ...record.repoFingerprint.frameworks]);
      const rating = record.rating.explicit * 2 + record.rating.implicit;
      const score = this.matcher === "lexical" ? lexical * 0.7 + stack * 0.3 : lexical * 0.45 + phrase * 0.25 + stack * 0.3;
      return { record, score, rating };
    });
    const positive = candidates.filter((item) => item.score >= this.threshold && item.rating >= 0).sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit - 1));
    const negative = candidates.filter((item) => item.score >= this.threshold && item.rating < 0).sort((a, b) => b.score - a.score).slice(0, 1);
    return [...positive, ...negative].map((item) => item.record);
  }

  async record(run: SwarmRun, brief: RepoBrief): Promise<CaseRecord | undefined> {
    if (!run.plan || !run.outcome || run.outcome === "planned") return undefined;
    await ensurePrivateDir(this.root);
    const record = buildCaseRecord(run, run.plan, brief);
    await atomicWriteJson(join(this.root, `${record.id}.json`), record);
    await this.prune();
    return record;
  }

  async rate(id: string, rating: -1 | 0 | 1): Promise<CaseRecord> {
    const path = join(this.root, `${safeId(id)}.json`);
    const record = JSON.parse(await readFile(path, "utf8")) as CaseRecord;
    record.rating.explicit = rating;
    await atomicWriteJson(path, record);
    return record;
  }

  async delete(id: string): Promise<void> {
    await unlink(join(this.root, `${safeId(id)}.json`));
  }

  private async prune(): Promise<void> {
    const records = await this.list();
    if (records.length <= this.max) return;
    const now = Date.now();
    const scored = records.map((record) => {
      const quality = record.rating.explicit * 2 + record.rating.implicit;
      const recency = Math.max(0, 1 - (now - record.ts) / (180 * 86400_000));
      return { record, score: quality * 0.7 + recency * 0.3 };
    });
    scored.sort((a, b) => a.score - b.score);
    for (const item of scored.slice(0, records.length - this.max)) await this.delete(item.record.id);
  }
}

function trigramSimilarity(left: string, right: string): number {
  const grams = (value: string) => {
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    const result = new Set<string>();
    for (let index = 0; index < normalized.length - 2; index++) result.add(normalized.slice(index, index + 3));
    return result;
  };
  return jaccard(grams(left), grams(right));
}

function buildCaseRecord(run: SwarmRun, plan: SwarmPlan, brief: RepoBrief): CaseRecord {
  const retries = Object.values(run.workers).reduce((sum, worker) => sum + worker.retries, 0);
  const workers = Object.values(run.workers);
  const implicit = (run.planEdits.length === 0 ? 1 : 0) + (workers.every((worker) => worker.retries === 0) ? 1 : 0) + (run.conflicts.length === 0 ? 0.5 : 0) + (run.outcome === "failed" || run.outcome === "aborted" ? -2 : 0.5);
  return {
    id: makeRunId(),
    ts: Date.now(),
    repoFingerprint: {
      langs: brief.languages,
      frameworks: brief.frameworks,
      sizeBucket: brief.fileCount < 100 ? "s" : brief.fileCount < 1000 ? "m" : "l",
    },
    taskText: redactTask(run.task).slice(0, 500),
    taskTags: tokenizeTask(redactTask(run.task)),
    planSkeleton: {
      subtaskCount: plan.subtasks.length,
      waves: countWaves(plan),
      roles: plan.subtasks.map((task) => task.role),
      dagShape: describeDag(plan),
      contractKinds: Array.from(new Set(plan.contracts.map((contract) => contract.kind))),
      ownershipPattern: "exclusive-paths",
    },
    strategy: plan.strategy.slice(0, 2_000),
    metrics: {
      onePassRate: workers.length ? workers.filter((worker) => worker.retries === 0 && worker.status === "done").length / workers.length : 0,
      retries,
      conflicts: run.conflicts.length,
      durationSec: run.totals.wallSec,
      cost: run.totals.cost,
      planEditCount: run.planEdits.length,
    },
    rating: { explicit: 0, implicit },
    outcome: run.outcome === "planned" ? "failed" : run.outcome ?? "failed",
  };
}

function redactTask(task: string): string {
  return task
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "<redacted-token>")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "<redacted-blob>");
}

function safeId(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 case id");
  return id;
}

function countWaves(plan: SwarmPlan): number {
  const depth = new Map<string, number>();
  for (const id of plan.mergeOrder) {
    const task = plan.subtasks.find((item) => item.id === id)!;
    depth.set(id, 1 + Math.max(0, ...task.dependsOn.map((dep) => depth.get(dep) ?? 0)));
  }
  return Math.max(0, ...depth.values());
}

function describeDag(plan: SwarmPlan): string {
  const waves = countWaves(plan);
  return `${plan.subtasks.length} tasks/${waves} waves`;
}
