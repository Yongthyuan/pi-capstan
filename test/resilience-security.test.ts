import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.ts";
import { JsonResponseError } from "../src/llm.ts";
import { createPlan } from "../src/planner.ts";
import { pruneRunArtifacts } from "../src/state.ts";
import { canonicalWriteTarget } from "../src/utils.ts";
import { verifyCommands } from "../src/verifier.ts";

test("verification rejects shell composition before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-verify-policy-"));
  try {
    const marker = join(root, "owned");
    const result = await verifyCommands([`npm test; touch ${marker}`], root, 1, { allowedPrefixes: ["npm test"] });
    assert.equal(result.ok, false);
    assert.equal(result.commands[0]?.blocked, true);
    await assert.rejects(stat(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification timeout escalates from TERM to KILL", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-verify-timeout-"));
  try {
    const script = join(root, "hang.mjs");
    await writeFile(script, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
    await chmod(script, 0o700);
    const started = Date.now();
    const result = await verifyCommands(["./hang.mjs"], root, 1, { allowedPrefixes: ["./hang.mjs"] });
    assert.equal(result.ok, false);
    assert.equal(result.commands[0]?.timedOut, true);
    assert.equal(Date.now() - started >= 3_000, true);
    assert.equal(Date.now() - started < 5_000, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification subprocesses do not inherit credential-like environment variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-verify-env-"));
  const prior = process.env.SWARM_TEST_API_KEY;
  try {
    process.env.SWARM_TEST_API_KEY = "must-not-leak";
    const script = join(root, "env-check.mjs");
    await writeFile(script, "#!/usr/bin/env node\nprocess.exit(process.env.SWARM_TEST_API_KEY ? 9 : 0);\n");
    await chmod(script, 0o700);
    const result = await verifyCommands(["./env-check.mjs"], root, 5, { allowedPrefixes: ["./env-check.mjs"] });
    assert.equal(result.ok, true);
  } finally {
    if (prior === undefined) delete process.env.SWARM_TEST_API_KEY;
    else process.env.SWARM_TEST_API_KEY = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("planner repairs malformed JSON responses", async () => {
  let repaired = 0;
  const plan: any = {
    schemaVersion: 1,
    taskSummary: "repair",
    strategy: "parallel",
    contracts: [],
    subtasks: [
      { id: "a", title: "a", goal: "a", role: "a", rolePrompt: "a", ownedPaths: ["a/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: ["npm test"], criteria: [] } },
      { id: "b", title: "b", goal: "b", role: "b", rolePrompt: "b", ownedPaths: ["b/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: ["npm test"], criteria: [] } },
    ],
    mergeOrder: ["a", "b"],
    risks: [],
  };
  const llm: any = {
    availableModels: () => [],
    plan: async () => { throw new JsonResponseError("Unexpected end", "{bad"); },
    repairPlan: async (raw: string) => { repaired++; assert.equal(raw, "{bad"); return plan; },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  const result = await createPlan("repair", { repoRoot: "/tmp", fileCount: 0, languages: [], frameworks: [], tree: "", evidence: "", summary: "empty" }, [], llm, config);
  assert.equal("taskSummary" in result && result.taskSummary, "repair");
  assert.equal(repaired, 1);
});

test("retention removes only expired logs and sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-retention-"));
  try {
    const logs = join(root, "r1", "logs");
    const sessions = join(root, "r1", "sessions", "w1");
    await mkdir(logs, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const oldLog = join(logs, "old.jsonl");
    const freshLog = join(logs, "fresh.jsonl");
    const oldSession = join(sessions, "old.jsonl");
    await writeFile(oldLog, "old");
    await writeFile(freshLog, "fresh");
    await writeFile(oldSession, "old");
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldLog, old, old);
    await utimes(oldSession, old, old);
    await utimes(sessions, old, old);
    await pruneRunArtifacts(root, { logsDays: 14, sessionsDays: 30 });
    await assert.rejects(stat(oldLog));
    await stat(freshLog);
    await assert.rejects(stat(sessions));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical write target supports multiple missing parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-canonical-"));
  try {
    assert.equal(await canonicalWriteTarget("a/b/c.txt", root), join(await realpath(root), "a", "b", "c.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid nested config fails with a useful error", () => {
  const config: any = structuredClone(DEFAULT_CONFIG);
  config.worker = null;
  assert.throws(() => validateConfig(config), /worker/);
});
