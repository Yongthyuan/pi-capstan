import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.ts";
import { JsonResponseError } from "../src/llm.ts";
import { createPlan } from "../src/planner.ts";
import { pruneRunArtifacts } from "../src/state.ts";
import { canonicalWriteTarget } from "../src/utils.ts";
import { verifyCommands } from "../src/verifier.ts";
import { buildGuardSource, STRICT_BASH_DENYLIST } from "../src/guard-template.ts";

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
    // Invoked via `node` rather than shebang exec: fresh executable scripts
    // can stall for seconds in loaded environments, making this test flaky.
    await writeFile(script, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
    const started = Date.now();
    const result = await verifyCommands(["node hang.mjs"], root, 1, { allowedPrefixes: ["node hang.mjs"] });
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
    await writeFile(script, "process.exit(process.env.SWARM_TEST_API_KEY ? 9 : 0);\n");
    const result = await verifyCommands(["node env-check.mjs"], root, 5, { allowedPrefixes: ["node env-check.mjs"] });
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

test("worker guard exposes scoped filesystem and mailbox tools", () => {
  const source = buildGuardSource({
    runDir: "/tmp/run",
    worktree: "/tmp/worktree",
    heartbeatFile: "/tmp/run/heartbeat",
    task: { id: "a", title: "a", goal: "a", role: "a", rolePrompt: "a", ownedPaths: ["src/**"], sharedPaths: ["package-lock.json"], generatedPaths: ["generated/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [], criteria: [] } },
    trusted: true,
    config: structuredClone(DEFAULT_CONFIG),
    peers: ["b"],
  });
  assert.match(source, /name: "swarm_send"/);
  assert.match(source, /name: "swarm_inbox"/);
  assert.match(source, /name: "swarm_fs"/);
  assert.match(source, /package-lock\.json/);
  assert.match(source, /"peers":\["b"\]/);
  const deny = DEFAULT_CONFIG.bashDenylist.map((value) => new RegExp(value, "i"));
  assert.equal(deny.some((expression) => expression.test("git -c user.name=x rm secret.txt")), true);
  assert.equal(deny.some((expression) => expression.test("git diff --stat HEAD")), false);
});

test("strict bash denylist blocks interpreter escapes without breaking module runs", () => {
  const strict = STRICT_BASH_DENYLIST.map((value) => new RegExp(value, "i"));
  const blocked = [
    `python3 -c "open('../../x','w').write('x')"`,
    `node -e "require('fs').writeFileSync('x','x')"`,
    `bun --eval "1"`,
    "perl -E 'say 1'",
    "sh -c 'rm file'",
    "find . -name '*.tmp' -delete",
    "find src -exec touch {} +",
  ];
  for (const command of blocked) assert.equal(strict.some((expression) => expression.test(command)), true, command);
  const allowed = [
    "python -m pytest",
    "node scripts/build.mjs",
    "npm run build",
    "bash tools/setup.sh",
    "find src -name '*.ts'",
  ];
  for (const command of allowed) assert.equal(strict.some((expression) => expression.test(command)), false, command);
  const config = structuredClone(DEFAULT_CONFIG);
  config.worker.strictBash = true;
  const source = buildGuardSource({
    runDir: "/tmp/run",
    worktree: "/tmp/worktree",
    heartbeatFile: "/tmp/run/heartbeat",
    task: { id: "a", title: "a", goal: "a", role: "a", rolePrompt: "a", ownedPaths: ["src/**"], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [], criteria: [] } },
    trusted: true,
    config,
  });
  assert.match(source, /--eval/);
});
