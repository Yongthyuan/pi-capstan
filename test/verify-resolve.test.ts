import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { validateConfig } from "../src/config-validator.ts";
import { generateConfigFromAnswers } from "../src/config-wizard.ts";
import { parsePorcelainStatus } from "../src/workspace.ts";
import { resolveVerifyCommands, skippedVerification, verifyCommands } from "../src/verifier.ts";
import { buildReport } from "../src/reporter.ts";
import type { SwarmRun } from "../src/types.ts";

test("resolveVerifyCommands: fallback wins, [] skips, null detects", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-resolve-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "node --test" } }));
    const fallback = await resolveVerifyCommands({
      configured: ["npm test"],
      cwd: root,
      full: true,
      fallback: ["npm run typecheck"],
    });
    assert.deepEqual(fallback, ["npm run typecheck"]);

    const skip = await resolveVerifyCommands({ configured: [], cwd: root, full: true });
    assert.deepEqual(skip, []);

    const detect = await resolveVerifyCommands({ configured: null, cwd: root, full: true });
    assert.ok(detect.includes("npm run typecheck"));
    assert.ok(detect.includes("npm test"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty verification is skipped, not a fake pass in reports", async () => {
  const empty = await verifyCommands([], process.cwd(), 1);
  assert.equal(empty.skipped, true);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.commands, []);
  const skipped = skippedVerification();
  const run = {
    runId: "r1",
    task: "demo",
    phase: "done",
    workers: {},
    conflicts: [],
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, wallSec: 1, turns: 0 },
    planRevision: 1,
  } as unknown as SwarmRun;
  const report = buildReport(run, skipped);
  assert.match(report, /集成全量: 跳过/);
  assert.doesNotMatch(report, /集成全量: ✓ 无命令/);
});

test("porcelain parser classifies added/modified/deleted", () => {
  const parsed = parsePorcelainStatus(" M src/a.ts\nA  src/b.ts\n?? src/c.ts\n D src/d.ts\n");
  assert.deepEqual(parsed.modified, ["src/a.ts"]);
  assert.deepEqual(parsed.added.sort(), ["src/b.ts", "src/c.ts"]);
  assert.deepEqual(parsed.deleted, ["src/d.ts"]);
});

test("DEFAULT_CONFIG has 51 leaf keys", () => {
  const countLeaves = (value: unknown): number => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.values(value as Record<string, unknown>).reduce<number>((sum, nested) => sum + countLeaves(nested), 0);
    }
    return 1;
  };
  assert.equal(countLeaves(DEFAULT_CONFIG), 51);
});

test("default config validate warns that verify lanes auto-detect", () => {
  const result = validateConfig(DEFAULT_CONFIG);
  assert.equal(result.valid, true);
  assert.ok(result.issues.some((issue) => issue.path === "run.verify" && issue.level === "warning"));
});

test("wizard untrusted skips verify; production comprehensive auto-detects", () => {
  const untrusted = generateConfigFromAnswers({
    useCase: "untrusted-code",
    qualityLevel: "balanced",
    verification: "minimal",
  });
  assert.ok(untrusted.worker?.tools?.includes("edit"));
  assert.ok(untrusted.worker?.tools?.includes("write"));
  assert.deepEqual(untrusted.run?.verify, { worker: [], integrationLight: [], full: [] });

  const untrustedStrict = generateConfigFromAnswers({
    useCase: "untrusted-code",
    qualityLevel: "high",
    verification: "comprehensive",
  });
  assert.deepEqual(untrustedStrict.run?.verify, { worker: [], integrationLight: [], full: [] });

  const high = generateConfigFromAnswers({
    useCase: "production-feature",
    qualityLevel: "high",
    verification: "comprehensive",
  });
  assert.equal(high.run?.verify?.full, null);
});
