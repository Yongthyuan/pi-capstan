import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace.ts";
import { runCommand } from "../src/utils.ts";

test("workspace creates, commits and merges isolated task worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-workspace-"));
  const repo = join(root, "repo");
  const runDir = join(repo, ".pi", "swarm", "runs", "r1");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "r1", runDir, worktreesRoot: join(root, "worktrees") });
    const state = await workspace.prepare(false);
    const task: any = { id: "a", title: "add source", ownedPaths: ["src/**"] };
    const child = await workspace.createTaskWorktree(task);
    await mkdir(join(child.path, "src"), { recursive: true });
    await writeFile(join(child.path, "src", "a.ts"), "export const a = 1;\n");
    const commit = await workspace.commitTask(task, child.path);
    assert.deepEqual(commit.files, ["src/a.ts"]);
    const operation = await workspace.beginCandidate("wave", "r1-wave-1");
    assert.equal((await workspace.mergeTask(task, child.branch, operation)).ok, true);
    assert.equal(await existsAt(state.integrationWorktree, "src/a.ts"), false);
    operation.phase = "verified";
    await workspace.promoteCandidate(operation);
    assert.equal(await existsAt(state.integrationWorktree, "src/a.ts"), true);
    const landing = await workspace.land("branch");
    assert.equal(landing.outcome, "branch");
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dirty temporary baseline can execute but never auto-applies", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-dirty-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    await writeFile(join(repo, "README.md"), "base\nuser dirty\n");
    const workspace = new WorkspaceManager({ cwd: repo, runId: "dirty", runDir: join(repo, ".pi", "swarm", "runs", "dirty"), worktreesRoot: join(root, "worktrees") });
    const state = await workspace.prepare(true);
    assert.equal(state.dirtyBase, true);
    assert.equal((await workspace.land("apply")).outcome, "branch");
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume recreates missing worktrees from existing swarm branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-resume-tree-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "resume", runDir: join(repo, ".pi", "swarm", "runs", "resume"), worktreesRoot: join(root, "worktrees") });
    const state = await workspace.prepare(false);
    const task: any = { id: "a", title: "a", ownedPaths: ["src/**"] };
    const child = await workspace.createTaskWorktree(task);
    await git(repo, ["worktree", "remove", "--force", child.path]);
    const restoredChild = await workspace.createTaskWorktree(task);
    assert.equal(restoredChild.path, child.path);
    assert.equal(await existsAt(restoredChild.path, "README.md"), true);
    await git(repo, ["worktree", "remove", "--force", state.integrationWorktree]);
    await workspace.ensureIntegrationWorktree();
    assert.equal(await existsAt(state.integrationWorktree, "README.md"), true);
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discarded candidate never contaminates the last-green integration branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-candidate-fail-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "candidate-fail", runDir: join(repo, ".pi", "swarm", "runs", "candidate-fail"), worktreesRoot: join(root, "worktrees") });
    const state = await workspace.prepare(false);
    const before = await gitOutput(state.integrationWorktree, ["rev-parse", "HEAD"]);
    const task: any = { id: "a", title: "a", ownedPaths: ["src/**"] };
    const child = await workspace.createTaskWorktree(task);
    await mkdir(join(child.path, "src"), { recursive: true });
    await writeFile(join(child.path, "src", "bad.ts"), "broken\n");
    await workspace.commitTask(task, child.path);
    const operation = await workspace.beginCandidate("wave", "candidate-fail-wave");
    assert.equal((await workspace.mergeTask(task, child.branch, operation)).ok, true);
    assert.equal(await existsAt(operation.candidateWorktree, "src/bad.ts"), true);
    await workspace.discardCandidate(operation);
    assert.equal(await gitOutput(state.integrationWorktree, ["rev-parse", "HEAD"]), before);
    assert.equal(await existsAt(state.integrationWorktree, "src/bad.ts"), false);
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery reconciles a candidate promoted just before state persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-promote-reconcile-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "reconcile", runDir: join(repo, ".pi", "swarm", "runs", "reconcile"), worktreesRoot: join(root, "worktrees") });
    await workspace.prepare(false);
    const task: any = { id: "a", title: "a", ownedPaths: ["src/**"] };
    const child = await workspace.createTaskWorktree(task);
    await mkdir(join(child.path, "src"), { recursive: true });
    await writeFile(join(child.path, "src", "a.ts"), "ok\n");
    await workspace.commitTask(task, child.path);
    const operation = await workspace.beginCandidate("wave", "reconcile-wave");
    await workspace.mergeTask(task, child.branch, operation);
    operation.phase = "verified";
    const persistedBeforePromotion = structuredClone(operation);
    await workspace.promoteCandidate(operation);
    const run: any = { plan: { mergeOrder: ["a"] }, workers: { a: { branch: child.branch, status: "merging" } }, merged: [], gitOperations: [persistedBeforePromotion] };
    await workspace.reconcileOperation(run);
    assert.equal(run.gitOperations[0].phase, "promoted");
    assert.deepEqual(run.merged, ["a"]);
    assert.equal(run.workers.a.status, "done");
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function existsAt(root: string, path: string) {
  const { access } = await import("node:fs/promises");
  try { await access(join(root, path)); return true; } catch { return false; }
}
