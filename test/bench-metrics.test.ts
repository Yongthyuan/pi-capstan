import test from "node:test";
import assert from "node:assert/strict";
import { classifyFail, computeTotals, qualityPassFor } from "../scripts/bench/metrics.ts";

test("benchmark counts each case once and separates provider failures from completion", () => {
  const totals = computeTotals([
    { outcome: "plan", category: "a", fixture: "one", difficulty: "easy", golden: { pass: true } },
    { outcome: "error", category: "a", fixture: "one", difficulty: "easy", error: "502 Bad Gateway" },
    { outcome: "error", category: "b", fixture: "two", difficulty: "hard", error: "429 rate limit" },
  ]);
  assert.equal(totals.crossTabs.byCategory.a!.n, 2);
  assert.equal(Object.values(totals.crossTabs.byFixture).reduce((sum, item) => sum + item.n, 0), 3);
  assert.equal(totals.infraFailRate, 2 / 3);
  assert.equal(totals.completionRate, 1 / 3);
  assert.equal(totals.eligibleCompletionRate, 1);
  assert.equal(totals.qualityEligibleCases, 1);
});

test("benchmark diagnoses wrong routing and golden failures without a provider error", () => {
  assert.equal(classifyFail({ outcome: "solo", expectOutcome: "plan" }), "solo_unexpected");
  assert.equal(classifyFail({ outcome: "plan", expectOutcome: "solo" }), "plan_unexpected");
  assert.equal(classifyFail({ outcome: "plan", golden: { pass: false } }), "golden_fail");
  assert.equal(classifyFail({ outcome: "error", error: "Planner output token limit reached (16000)" }), "output_limit");
  assert.equal(qualityPassFor({ outcome: "plan", expectOutcome: "solo" }), false);
  assert.equal(qualityPassFor({ outcome: "plan", expectOutcome: "either", golden: { pass: false } }), false);
});

test("retry success preserves initial failure and includes every attempt's cost", () => {
  const totals = computeTotals([{
    outcome: "plan", cost: 0.2, firstPassValid: true,
    attempts: [
      { outcome: "error", error: "invalid JSON", cost: 0.1, tokens: 10, wallMs: 40, schemaRetriesUsed: 2 },
      { outcome: "plan", cost: 0.2, tokens: 20, wallMs: 50, firstPassValid: true },
    ],
  }]);
  assert.equal(totals.attempts, 2);
  assert.equal(totals.firstPassValidRate, 0);
  assert.equal(totals.firstAttemptCompletionRate, 0);
  assert.equal(totals.completionRate, 1);
  assert.ok(Math.abs(totals.totalCost - 0.3) < 1e-9);
  assert.equal(totals.totalTokens, 30);
  assert.equal(totals.medianWallMs, 90);
});
