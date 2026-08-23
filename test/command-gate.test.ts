import test from "node:test";
import assert from "node:assert/strict";
import { parseCapstanCommand, splitArgs } from "../src/command.ts";
import { decideGate, ruleGate } from "../src/gate.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("command parser preserves quoted task and flags", () => {
  const parsed = parseCapstanCommand('--force --max 3 "implement auth and tests" --budget 1.5 --best-of 2');
  assert.equal(parsed.task, "implement auth and tests");
  assert.equal(parsed.force, true);
  assert.equal(parsed.max, 3);
  assert.equal(parsed.budget, 1.5);
  assert.equal(parsed.bestOf, 2);
  assert.deepEqual(parseCapstanCommand("merge run-1").rest, ["run-1"]);
  assert.equal(parseCapstanCommand("pr run-1").action, "pr");
  assert.deepEqual(splitArgs("'a b' c"), ["a b", "c"]);
});

test("command parser warns when unknown flags fall into task text", () => {
  const parsed = parseCapstanCommand("fix login bug --budgt 8");
  assert.equal(parsed.task, "fix login bug --budgt 8");
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0]!.includes("--budgt"), true);
  assert.deepEqual(parseCapstanCommand('--budget 2 "quoted task"').warnings, []);
});

test("rule gate separates a single action from a broad task", async () => {
  assert.ok(ruleGate("改一行 typo", 10).score <= 0);
  const broad = ruleGate("重构所有模块，同时更新代码、测试以及文档，涉及 src/a.ts src/b.ts web/c.ts", 400);
  assert.ok(broad.score >= 5);
  const simple = await decideGate("解释这个函数", 20, "20 files", DEFAULT_CONFIG.gate);
  assert.equal(simple.decision, "simple");
});
