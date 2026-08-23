import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoLock } from "../src/repo-lock.ts";
import { RunStore } from "../src/state.ts";
import { buildRepoBrief } from "../src/planner.ts";
import { PiLlmClient } from "../src/llm.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { emptyUsage, runCommand } from "../src/utils.ts";
import { sanitizeRpcLogLine } from "../src/worker.ts";

test("repository lock rejects a second Pi process owner and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-lock-"));
  try {
    await runCommand("git", ["init", "-q"], { cwd: root });
    const first = await RepoLock.forRepo(root, "first");
    const second = await RepoLock.forRepo(root, "second");
    await first.acquire();
    await assert.rejects(second.acquire(), /已有活跃 capstan run first/);
    await first.release();
    await second.acquire();
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run store recovers from the previous atomic state and reports unrecoverable corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-state-backup-"));
  try {
    const store = new RunStore(root);
    const run: any = { schemaVersion: 1, runId: "r1", createdAt: 1, updatedAt: 1, cwd: root, task: "task", phase: "executing", planEdits: [], workers: {}, merged: [], conflicts: [], totals: { ...emptyUsage(), wallSec: 0, turns: 0 }, runDir: join(root, "r1") };
    await store.save(run);
    run.phase = "done";
    await store.save(run);
    await writeFile(store.statePath("r1"), "{broken", { mode: 0o600 });
    assert.equal((await store.load("r1")).phase, "executing");
    await writeFile(join(store.runDir("r1"), "state.prev.json"), "{also-broken", { mode: 0o600 });
    assert.deepEqual(await store.list(), []);
    assert.equal(store.diagnostics.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo brief includes untracked content evidence with source line numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-scout-"));
  const originalPath = process.env.PATH;
  try {
    await runCommand("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "service.ts"), "export function authenticateUser() { return true; }\n");
    if (process.platform !== "win32") {
      const gitPath = (await runCommand("which", ["git"])).stdout.trim();
      const bin = join(root, "bin");
      await mkdir(bin);
      await symlink(gitPath, join(bin, "git"));
      process.env.PATH = bin;
    }
    const brief = await buildRepoBrief(root, "fix authenticateUser behavior");
    assert.match(brief.evidence, /src\/service\.ts/);
    assert.match(brief.evidence, /1: export function authenticateUser/);
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("repo brief expands task hits through import and test/source neighborhoods", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-structural-scout-"));
  try {
    await runCommand("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "widget-service.ts"), "import type { Widget } from './widget-types';\nexport class WidgetService {}\n");
    await writeFile(join(root, "src", "widget-types.ts"), "export interface Widget { id: string }\n");
    await writeFile(join(root, "src", "widget-service.test.ts"), "test('widget', () => {});\n");
    const brief = await buildRepoBrief(root, "change WidgetService behavior");
    assert.match(brief.evidence, /src\/widget-service\.ts/);
    assert.match(brief.evidence, /src\/widget-types\.ts/);
    assert.match(brief.evidence, /src\/widget-service\.test\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner model calls carry bounded provider options and account usage", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.planner.timeoutSec = 17;
  config.planner.tokenLimit = 12_345;
  let seenOptions: any;
  let accounted = 0;
  const model = { provider: "fake", id: "planner" };
  const client = new PiLlmClient({
    model,
    modelRegistry: {
      getAvailable: () => [model],
      find: () => model,
      hasConfiguredAuth: () => true,
      complete: async (_model, _context, options) => {
        seenOptions = options;
        return { content: [{ type: "text", text: '{"complexity":5,"parallelizable":true,"reason":"ok","estSubtasks":2}' }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } };
      },
    },
  }, config, async (usage) => { accounted += usage.input + usage.output; });
  await client.classify("task", "repo", []);
  assert.equal(seenOptions.timeoutMs, 17_000);
  assert.equal(seenOptions.maxTokens, 12_345);
  assert.equal(accounted, 15);
});

test("RPC logs remove prompts, commands and common credentials", () => {
  const fakeSecret = ["sk", "example-secret-value"].join("-");
  const tool = sanitizeRpcLogLine(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: `curl -H 'Authorization: Bearer ${fakeSecret}'` } }));
  assert.equal(tool.includes("curl"), false);
  assert.equal(tool.includes("sk-secret"), false);
  const message = sanitizeRpcLogLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "github_pat_secret" }], usage: { input: 1 } } }));
  assert.equal(message.includes("github_pat_secret"), false);
  const update = sanitizeRpcLogLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "raw model reasoning" } }));
  assert.equal(update.includes("raw model reasoning"), false);
  assert.deepEqual(JSON.parse(update), { type: "message_update", event: "thinking_delta" });
});
