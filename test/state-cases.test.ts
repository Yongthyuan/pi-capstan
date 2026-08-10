import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/state.ts";
import { CaseStore } from "../src/cases.ts";
import { emptyUsage } from "../src/utils.ts";

test("run store persists and finds unfinished runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-state-"));
  try {
    const store = new RunStore(root);
    const run: any = { schemaVersion: 1, runId: "r1", createdAt: 1, updatedAt: 1, cwd: root, task: "task", phase: "executing", planEdits: [], workers: {}, merged: [], conflicts: [], totals: { ...emptyUsage(), wallSec: 0, turns: 0 }, runDir: join(root, "r1") };
    await store.save(run);
    assert.equal((await store.load("r1")).phase, "executing");
    assert.equal((await store.unfinished()).length, 1);
    run.phase = "done";
    await store.save(run);
    assert.equal((await store.unfinished()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case store rates records", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-cases-"));
  try {
    const store = new CaseStore(root, 10, 0.1);
    const record: any = { id: "c1", ts: Date.now(), repoFingerprint: { langs: ["ts"], frameworks: ["node"], sizeBucket: "s" }, taskText: "auth tests", taskTags: ["auth", "tests"], planSkeleton: { subtaskCount: 2, waves: 1, roles: ["a", "b"], dagShape: "2/1", contractKinds: [], ownershipPattern: "paths" }, strategy: "parallel", metrics: { onePassRate: 1, retries: 0, conflicts: 0, durationSec: 1, cost: 0, planEditCount: 0 }, rating: { explicit: 0, implicit: 1 }, outcome: "branch" };
    const { atomicWriteJson } = await import("../src/utils.ts");
    await atomicWriteJson(join(root, "c1.json"), record);
    assert.equal((await store.rate("c1", 1)).rating.explicit, 1);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
