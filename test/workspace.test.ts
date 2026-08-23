import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace.ts";
import { runCommand } from "../src/utils.ts";

test("workspace creates, commits and merges isolated task worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-workspace-"));
  const repo = join(root, "repo");
  const runDir = join(repo, ".pi", "capstan", "runs", "r1");
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
  const root = await mkdtemp(join(tmpdir(), "capstan-dirty-"));
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
    const workspace = new WorkspaceManager({ cwd: repo, runId: "dirty", runDir: join(repo, ".pi", "capstan", "runs", "dirty"), worktreesRoot: join(root, "worktrees") });
    const state = await workspace.prepare(true);
    assert.equal(state.dirtyBase, true);
    assert.equal((await workspace.land("apply")).outcome, "branch");
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed landing rolls the main worktree back and degrades to branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-land-rollback-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "land-fail", runDir: join(repo, ".pi", "capstan", "runs", "land-fail"), worktreesRoot: join(root, "worktrees") });
    await workspace.prepare(false);
    const task: any = { id: "a", title: "a", ownedPaths: ["src/**"] };
    const child = await workspace.createTaskWorktree(task);
    await mkdir(join(child.path, "src"));
    await writeFile(join(child.path, "src", "a.ts"), "ok\n");
    await workspace.commitTask(task, child.path);
    const operation = await workspace.beginCandidate("wave", "land-fail-wave");
    await workspace.mergeTask(task, child.branch, operation);
    operation.phase = "verified";
    await workspace.promoteCandidate(operation);
    const original = (workspace as any).gitCommand.bind(workspace);
    (workspace as any).gitCommand = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => {
      if (args[0] === "merge" && args.includes("--squash")) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "simulated mid-squash failure" });
      return original(cwd, args, env);
    };
    const landing = await workspace.land("apply");
    assert.equal(landing.outcome, "branch");
    assert.equal(landing.note.includes("已回滚主工作区"), true);
    assert.equal(await gitOutput(repo, ["status", "--porcelain"]), "");
    assert.equal(await existsAt(repo, "src/a.ts"), false);
    (workspace as any).gitCommand = original;
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktrees safely share an existing dependency directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-dependencies-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "deps", runDir: join(repo, ".pi", "capstan", "runs", "deps"), worktreesRoot: join(root, "worktrees") });
    await workspace.prepare(false);
    await mkdir(join(repo, "node_modules"));
    await writeFile(join(repo, "node_modules", "marker"), "shared\n");
    const task: any = { id: "a", title: "a", ownedPaths: ["**"] };
    const child = await workspace.createTaskWorktree(task);
    assert.deepEqual(await workspace.prepareTaskDependencies(child.path, ["node_modules"]), ["node_modules"]);
    assert.equal((await lstat(join(child.path, "node_modules"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(child.path, "node_modules", "marker"), "utf8"), "shared\n");
    await writeFile(join(child.path, "result.txt"), "ok\n");
    const committed = await workspace.commitTask(task, child.path, { ephemeralPaths: ["node_modules"] });
    assert.deepEqual(committed.files, ["result.txt"]);
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope cleanup reverts only out-of-scope paths and commits valid work", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-scope-revert-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "scope", runDir: join(repo, ".pi", "capstan", "runs", "scope"), worktreesRoot: join(root, "worktrees") });
    await workspace.prepare(false);
    const task: any = { id: "a", title: "a", ownedPaths: ["src/**"] };
    const child = await workspace.createTaskWorktree(task);
    await mkdir(join(child.path, "src"));
    await writeFile(join(child.path, "src", "ok.ts"), "ok\n");
    await writeFile(join(child.path, "README.md"), "out of scope\n");
    await writeFile(join(child.path, "rogue.txt"), "out of scope\n");
    const committed = await workspace.commitTask(task, child.path, { violationPolicy: "revert" });
    assert.deepEqual(committed.files, ["src/ok.ts"]);
    assert.deepEqual(committed.reverted.sort(), ["README.md", "rogue.txt"]);
    assert.equal((await readFile(join(child.path, "README.md"), "utf8")).replaceAll("\r\n", "\n"), "base\n");
    assert.equal(await existsAt(child.path, "rogue.txt"), false);
    await workspace.cleanupWorktrees(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume recreates missing worktrees from existing capstan branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-resume-tree-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "resume", runDir: join(repo, ".pi", "capstan", "runs", "resume"), worktreesRoot: join(root, "worktrees") });
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
  const root = await mkdtemp(join(tmpdir(), "capstan-candidate-fail-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "candidate-fail", runDir: join(repo, ".pi", "capstan", "runs", "candidate-fail"), worktreesRoot: join(root, "worktrees") });
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
  const root = await mkdtemp(join(tmpdir(), "capstan-promote-reconcile-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const workspace = new WorkspaceManager({ cwd: repo, runId: "reconcile", runDir: join(repo, ".pi", "capstan", "runs", "reconcile"), worktreesRoot: join(root, "worktrees") });
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

test("a persisted run branch can be applied after worktrees were cleaned", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-late-merge-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  try {
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    const runDir = join(repo, ".pi", "capstan", "runs", "late");
    const first = new WorkspaceManager({ cwd: repo, runId: "late", runDir, worktreesRoot: join(root, "worktrees") });
    const state = await first.prepare(false);
    const task: any = { id: "a", title: "a", ownedPaths: ["src/**"] };
    const child = await first.createTaskWorktree(task);
    await mkdir(join(child.path, "src"));
    await writeFile(join(child.path, "src", "late.ts"), "ok\n");
    await first.commitTask(task, child.path);
    const operation = await first.beginCandidate("wave", "late-wave");
    await first.mergeTask(task, child.branch, operation);
    operation.phase = "verified";
    await first.promoteCandidate(operation);
    await first.cleanupWorktrees(true);

    const restarted = new WorkspaceManager({ cwd: repo, runId: "late", runDir, worktreesRoot: join(root, "worktrees") });
    restarted.restore(state);
    const landing = await restarted.land("apply");
    assert.equal(landing.outcome, "applied");
    assert.equal(await existsAt(repo, "src/late.ts"), true);
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
