import test from "node:test";
import assert from "node:assert/strict";
import { globsMayOverlap, sanitizePlanAcceptance, validatePlan } from "../src/plan-validation.ts";
import { globToRegExp, matchesAnyGlob } from "../src/utils.ts";
import { parseJsonFromText, repairCommonJsonIssues } from "../src/llm.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { expandHomePath } from "../src/utils.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const validPlan = {
  schemaVersion: 1 as const,
  taskSummary: "feature",
  strategy: "parallel modules",
  contracts: [{ id: "c1", kind: "interface" as const, description: "contract", definition: "x" }],
  subtasks: [
    { id: "a", title: "a", goal: "a", role: "a", rolePrompt: "a", ownedPaths: ["src/a/**"], readPaths: [], dependsOn: [], contracts: ["c1"], acceptance: { commands: ["true"], criteria: [] } },
    { id: "b", title: "b", goal: "b", role: "b", rolePrompt: "b", ownedPaths: ["src/b/**"], readPaths: [], dependsOn: [], contracts: ["c1"], acceptance: { commands: ["true"], criteria: [] } },
  ],
  mergeOrder: ["a", "b"],
  risks: [],
};

test("validates DAG and exclusive ownership", () => {
  const result = validatePlan(validPlan);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.waves, [["a", "b"]]);
  assert.equal(globsMayOverlap(["src/**"], ["src/api/**"]), true);
  assert.equal(globsMayOverlap(["src/a/**"], ["src/b/**"]), false);
});

test("glob matcher supports recursive ownership", () => {
  assert.equal(globToRegExp("src/**").test("src/a/b.ts"), true);
  assert.equal(matchesAnyGlob("docs/readme.md", ["docs/**", "src/**"]), true);
});

test("rejects cyclic DAG", () => {
  const cyclic: any = structuredClone(validPlan);
  cyclic.subtasks[0]!.dependsOn = ["b"];
  cyclic.subtasks[1]!.dependsOn = ["a"];
  const result = validatePlan(cyclic);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("DAG")));
});

test("rejects traversal ids and malformed arrays without throwing", () => {
  const malformed: any = structuredClone(validPlan);
  malformed.subtasks[0].id = "../../escape";
  malformed.subtasks[0].dependsOn = "not-an-array";
  const result = validatePlan(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.includes("subtask.id") || error.includes("dependsOn")), true);
});

test("sanitizePlanAcceptance repairs piped shell and fills defaults", () => {
  const dirty: any = structuredClone(validPlan);
  dirty.subtasks[0].acceptance.commands = ["npm test | tee /tmp/out", "npm run check"];
  dirty.subtasks[1].acceptance.commands = ["echo hi && rm -rf /"];
  const { plan, repairs } = sanitizePlanAcceptance(dirty, DEFAULT_CONFIG.run.verifyAllowedPrefixes, ["npm test"]);
  assert.ok(repairs.length >= 1);
  assert.deepEqual(plan.subtasks[0]!.acceptance.commands, ["npm test", "npm run check"]);
  assert.deepEqual(plan.subtasks[1]!.acceptance.commands, ["npm test"]);
  const validation = validatePlan(plan);
  assert.equal(validation.ok, true, validation.errors.join("; "));
});

test("parseJsonFromText repairs trailing commas and bare keys", () => {
  const repaired = repairCommonJsonIssues('{recommend:"solo",reason:"x",}');
  assert.equal(JSON.parse(repaired).recommend, "solo");
  const parsed = parseJsonFromText('here\n```json\n{"schemaVersion":1,"taskSummary":"t","strategy":"s","contracts":[],"subtasks":[],"mergeOrder":[],"risks":[],}\n```');
  assert.equal((parsed as any).schemaVersion, 1);
});

test("expandHomePath expands tilde for safetyGuardPath-style configs", () => {
  assert.equal(expandHomePath("~/extensions/safety-guard.ts"), join(homedir(), "extensions/safety-guard.ts"));
  assert.equal(expandHomePath("/abs/path.ts"), "/abs/path.ts");
});
