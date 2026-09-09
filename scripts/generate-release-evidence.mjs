import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReport, buildProofCarryingPrBody } from "../src/reporter.ts";
import { emptyUsage } from "../src/utils.ts";

// Deterministic presentation comparison. No model, network, or publish calls.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineCommit = "4840524d189d825bf21880d32a8429344bee53c7";
const gitShow = (path) => execFileSync("git", ["show", `${baselineCommit}:${path}`], { cwd: repo, encoding: "utf8" });
const baselineReporter = gitShow("src/reporter.ts");
const baselineService = gitShow("src/service.ts");
const baselinePrTemplate = baselineService.match(/const body = (`Pi Capstan run[\s\S]*?`);/)?.[1];
assert.ok(baselinePrTemplate, "The pinned baseline PR template must match before comparison.");
// This is the exact template from the pinned, local source commit above.
const buildBaselinePr = new Function("run", `return ${baselinePrTemplate};`);
const output = join(repo, "docs/evidence/v0.11.0");
const temporary = await mkdtemp(join(tmpdir(), "capstan-report-comparison-"));
await mkdir(output, { recursive: true });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const checks = { ok: true, commands: [{ command: "npm test", exitCode: 0, stdout: "", stderr: "", durationMs: 1000, timedOut: false }] };
const skipped = { ok: true, skipped: true, commands: [] };
const task = (id) => ({ id, title: id, goal: `Implement ${id}`, role: "coder", rolePrompt: "Implement the assigned file.", ownedPaths: [`src/${id}.mjs`], readPaths: [], dependsOn: [], contracts: [], acceptance: { commands: [], criteria: [] } });
const fixture = {
  schemaVersion: 1, runId: "report_fixture", createdAt: 1, updatedAt: 2,
  cwd: "/fixture/repo", runDir: "/fixture/run", task: "Two independent modules",
  phase: "done", outcome: "branch", planEdits: [], partialSuccess: false,
  plan: { schemaVersion: 1, taskSummary: "Two independent modules", strategy: "split", contracts: [], subtasks: [task("alpha"), task("beta")], mergeOrder: ["alpha", "beta"], risks: [] },
  workers: Object.fromEntries(["alpha", "beta"].map((id) => [id, {
    subtaskId: id, status: "done", worktree: `/fixture/${id}`, branch: `task/${id}`,
    currentAction: "done", retries: 0, turns: 1, pendingUi: [], lastEventAt: 2,
    scopeViolations: [], usage: emptyUsage(), verification: skipped,
  }])),
  merged: ["alpha", "beta"], conflicts: [], totals: { ...emptyUsage(), wallSec: 1, turns: 2 },
  finalVerification: skipped,
  gitOperations: [{ operationId: "fixture_wave", kind: "wave", phase: "promoted", preMergeSha: "1".repeat(40), candidateSha: "2".repeat(40), postMergeSha: "3".repeat(40), candidateBranch: "candidate/fixture", candidateWorktree: "/fixture/candidate", subtaskIds: ["alpha", "beta"], verification: skipped, startedAt: 1, updatedAt: 2 }],
  git: { repoRoot: "/fixture/repo", baseCommit: "1".repeat(40), originBranch: "main", integrationBranch: "integration/fixture", integrationWorktree: "/fixture/integration", dirtyBase: false, initialHead: "1".repeat(40), initialStatusHash: "fixture" },
};

try {
  const modulePath = join(temporary, "reporter.ts");
  await writeFile(modulePath, baselineReporter);
  const { buildReport: buildBaselineReport } = await import(pathToFileURL(modulePath).href);
  const beforeReport = buildBaselineReport(fixture, fixture.finalVerification);
  const afterReport = buildReport(fixture);
  const beforePr = buildBaselinePr(fixture);
  const afterPr = buildProofCarryingPrBody(fixture);
  assert.match(beforeReport, /结果完整性: 完整/);
  assert.match(beforePr, /Merged verified subtasks: alpha, beta/);
  assert.match(beforePr, /Result: complete/);
  assert.match(afterReport, /验证证据不完整/);
  assert.match(afterPr, /complete; verification incomplete/);
  assert.doesNotMatch(afterReport, /完整成功/);

  const passed = structuredClone(fixture);
  for (const worker of Object.values(passed.workers)) worker.verification = checks;
  passed.gitOperations[0].verification = checks;
  passed.finalVerification = checks;
  assert.match(buildReport(passed), /完整成功/);
  const missing = structuredClone(passed);
  delete missing.finalVerification;
  assert.doesNotMatch(buildReport(missing), /完整成功/);
  const privateText = structuredClone(passed);
  privateText.workers.alpha.completionReport = "Synthetic path: /Users/example/private-project/notes.md";
  assert.match(buildBaselineReport(privateText), /\/Users\/example/);
  assert.doesNotMatch(buildReport(privateText), /\/Users\/example/);

  const files = {
    "report-fixture.json": JSON.stringify(fixture, null, 2) + "\n",
    "before-report.md": beforeReport, "after-report.md": afterReport,
    "before-pr.md": beforePr, "after-pr.md": afterPr,
    "passed-report.md": buildReport(passed),
    "missing-final-report.md": buildReport(missing),
  };
  // Normalize only the final newline for checked-in text artifacts.
  for (const name of Object.keys(files)) files[name] = files[name].trimEnd() + "\n";
  for (const [name, content] of Object.entries(files)) await writeFile(join(output, name), content);
  const summary = {
    kind: "deterministic report fixture; not an LLM benchmark",
    baseline: { version: "0.10.0", commit: baselineCommit, reporterSha256: sha256(baselineReporter), prTemplateSha256: sha256(baselinePrTemplate) },
    current: { version: JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version, reporterSha256: sha256(await readFile(join(repo, "src/reporter.ts"))) },
    assertions: { skippedChecksRequireReview: true, passedChecksRemainSuccessful: true, missingFinalChecksRequireReview: true, syntheticPrivatePathRedacted: true },
    artifacts: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { sha256: sha256(content) }])),
  };
  await writeFile(join(output, "comparison.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
