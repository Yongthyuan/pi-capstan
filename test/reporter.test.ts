import test from "node:test";
import assert from "node:assert/strict";
import { buildProofCarryingPrBody, buildReport } from "../src/reporter.ts";
import type { CapstanRun } from "../src/types.ts";
import { emptyUsage } from "../src/utils.ts";

function sampleRun(): CapstanRun {
  return {
    schemaVersion: 1,
    runId: "run_demo",
    createdAt: 1,
    updatedAt: 2,
    cwd: "/tmp/demo",
    task: "add oauth",
    phase: "done",
    plan: {
      schemaVersion: 1,
      taskSummary: "OAuth login",
      strategy: "split",
      contracts: [{ id: "auth-api", kind: "interface", description: "login", definition: "login(u,p)" }],
      subtasks: [
        {
          id: "worker-db",
          title: "db",
          goal: "add sessions table",
          role: "db",
          rolePrompt: "db",
          ownedPaths: ["src/db/**"],
          readPaths: [],
          dependsOn: [],
          contracts: ["auth-api"],
          acceptance: { commands: ["npm test"], criteria: [] },
        },
        {
          id: "worker-api",
          title: "api",
          goal: "add login route",
          role: "api",
          rolePrompt: "api",
          ownedPaths: ["src/api/**"],
          readPaths: [],
          dependsOn: ["worker-db"],
          contracts: ["auth-api"],
          acceptance: { commands: ["./node_modules/.bin/tsc --noEmit"], criteria: [] },
        },
      ],
      mergeOrder: ["worker-db", "worker-api"],
      risks: [],
    },
    planEdits: [],
    workers: {
      "worker-db": {
        subtaskId: "worker-db",
        status: "done",
        worktree: "/tmp/w1",
        branch: "b1",
        currentAction: "done",
        retries: 1,
        turns: 1,
        pendingUi: [],
        lastEventAt: 1,
        scopeViolations: ["README.md"],
        usage: { ...emptyUsage(), cost: 0.41, input: 100, output: 50 },
        verification: {
          ok: true,
          commands: [{ command: "npm test", exitCode: 0, stdout: "", stderr: "", durationMs: 1200, timedOut: false }],
        },
        revertedScopePaths: ["README.md"],
      },
      "worker-api": {
        subtaskId: "worker-api",
        status: "done",
        worktree: "/tmp/w2",
        branch: "b2",
        currentAction: "done",
        retries: 0,
        turns: 1,
        pendingUi: [],
        lastEventAt: 1,
        scopeViolations: [],
        usage: { ...emptyUsage(), cost: 0.22, input: 80, output: 40 },
        verification: {
          ok: true,
          commands: [{ command: "./node_modules/.bin/tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 800, timedOut: false }],
        },
      },
    },
    merged: ["worker-db", "worker-api"],
    conflicts: [{ incomingSubtask: "worker-api", files: ["src/api/types.ts"], resolved: true }],
    gitOperations: [
      {
        operationId: "op1",
        kind: "wave",
        phase: "promoted",
        preMergeSha: "7be104aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        candidateBranch: "capstan/run_demo/candidate-1",
        candidateWorktree: "/tmp/c",
        subtaskIds: ["worker-db", "worker-api"],
        candidateSha: "a3f9c2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        postMergeSha: "e91d33cccccccccccccccccccccccccccccccc",
        verification: {
          ok: true,
          commands: [{ command: "./node_modules/.bin/tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 8200, timedOut: false }],
        },
        startedAt: 1,
        updatedAt: 2,
      },
    ],
    totals: { ...emptyUsage(), cost: 0.63, input: 180, output: 90, wallSec: 95, turns: 4 },
    outcome: "branch",
    runDir: "/tmp/run",
    git: {
      repoRoot: "/tmp/demo",
      baseCommit: "7be104aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      originBranch: "main",
      integrationBranch: "capstan/run_demo",
      integrationWorktree: "/tmp/i",
      dirtyBase: false,
      initialHead: "7be104aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      initialStatusHash: "h",
    },
  };
}

test("delivery report includes transaction log and verdict", () => {
  const report = buildReport(sampleRun(), {
    ok: true,
    commands: [{ command: "npm test", exitCode: 0, stdout: "", stderr: "", durationMs: 3000, timedOut: false }],
  });
  assert.match(report, /结论.*建议合入/);
  assert.match(report, /交付报告 · 完成/);
  assert.match(report, /事务日志/);
  assert.match(report, /promoted/);
  assert.match(report, /每任务验收/);
  assert.match(report, /越界回滚/);
  assert.equal(report.includes("/tmp/demo"), false);
});

test("proof-carrying PR body has evidence and no local paths", () => {
  const body = buildProofCarryingPrBody(sampleRun());
  assert.match(body, /Proof-Carrying Delivery/);
  assert.match(body, /Transaction log/);
  assert.match(body, /worker-db/);
  assert.match(body, /git range-diff/);
  assert.equal(body.includes("/tmp/"), false);
});

test("skipped checks never become a successful delivery verdict or PR pass", () => {
  const run = sampleRun();
  const skipped = { ok: true, skipped: true, commands: [] };
  run.finalVerification = skipped;
  for (const worker of Object.values(run.workers)) worker.verification = skipped;
  run.gitOperations![0]!.verification = skipped;
  const report = buildReport(run);
  const body = buildProofCarryingPrBody(run);
  assert.match(report, /验证证据不完整/);
  assert.doesNotMatch(report, /完整成功|建议合入/);
  assert.match(body, /verification incomplete/);
  assert.match(body, /skipped/);
  assert.doesNotMatch(body, /Every landed commit passed|verify pass/);
});

test("PR reports failed, partial and legacy runs without claiming complete success", () => {
  const run = sampleRun();
  run.phase = "failed";
  assert.match(buildProofCarryingPrBody(run), /failed; promoted work only/);
  run.phase = "done";
  run.merged = ["worker-db"];
  assert.match(buildProofCarryingPrBody(run), /partial; review required/);
  run.merged = ["worker-db", "worker-api"];
  assert.match(buildProofCarryingPrBody(run), /unknown \/ 未记录/);
});

test("public evidence scrubs sensitive content inside goals, titles and verification commands", () => {
  const run = sampleRun();
  const fakeKey = "sk-" + "examplecredential1234567890";
  run.plan!.subtasks[0]!.goal = "read /Users/example/private/project and token=not-public";
  run.plan!.subtasks[1]!.title = "inspect C:\\Users\\example\\private";
  run.workers["worker-db"]!.verification!.commands[0]!.command = "npm test -- --config /etc/private/config.json --api-key=" + fakeKey;
  for (const content of [buildReport(run), buildProofCarryingPrBody(run)]) {
    assert.doesNotMatch(content, /\/Users\/example|C:\\Users|\/etc\/private|not-public/);
    assert.equal(content.includes(fakeKey), false);
    assert.match(content, /\[local-path\]/);
    assert.match(content, /\[redacted\]/);
  }
});
