import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { GitMergeOperation, GitRunState, MergeStrategy, Subtask, SwarmRun } from "./types.ts";
import { ensurePrivateDir, matchesAnyGlob, pathExists, runCommand, sha256 } from "./utils.ts";

export interface WorkspaceOptions {
  cwd: string;
  runId: string;
  runDir: string;
  worktreesRoot: string;
}

export class WorkspaceManager {
  readonly cwd: string;
  readonly runId: string;
  readonly runDir: string;
  readonly worktreesRoot: string;
  git?: GitRunState;

  constructor(options: WorkspaceOptions) {
    this.cwd = options.cwd;
    this.runId = options.runId;
    this.runDir = options.runDir;
    this.worktreesRoot = options.worktreesRoot;
  }

  async detectRepo(): Promise<string | undefined> {
    const result = await this.gitCommand(this.cwd, ["rev-parse", "--show-toplevel"]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  async prepare(allowDirtySnapshot: boolean): Promise<GitRunState> {
    const repoRoot = await this.detectRepo();
    if (!repoRoot) throw new Error("当前目录不是 Git 仓库；执行模式要求 Git，仍可使用 --plan-only");
    const [head, branch, status] = await Promise.all([
      this.mustGit(repoRoot, ["rev-parse", "HEAD"]),
      this.gitCommand(repoRoot, ["branch", "--show-current"]),
      this.mustGit(repoRoot, ["status", "--porcelain=v1", "-uall"]),
    ]);
    const dirty = Boolean(status.trim());
    if (dirty && !allowDirtySnapshot) throw new Error("工作区有未提交更改；请提交后再执行，或在确认时允许只生成 branch 的临时基线");
    let baseCommit = head.trim();
    if (dirty) baseCommit = await this.createTemporaryBaseline(repoRoot, baseCommit);
    const root = join(this.worktreesRoot, sha256(repoRoot).slice(0, 12), this.runId);
    await ensurePrivateDir(root);
    const integrationWorktree = join(root, "integration");
    const integrationBranch = `swarm/${this.runId}/integration`;
    await this.mustGit(repoRoot, ["worktree", "add", "-b", integrationBranch, integrationWorktree, baseCommit]);
    this.git = {
      repoRoot,
      baseCommit,
      originBranch: branch.stdout.trim() || "(detached)",
      integrationBranch,
      integrationWorktree,
      dirtyBase: dirty,
      initialHead: head.trim(),
      initialStatusHash: sha256(status),
    };
    return this.git;
  }

  restore(git: GitRunState): void {
    this.git = git;
  }

  async ensureIntegrationWorktree(): Promise<void> {
    const git = this.requireGit();
    if (await this.isWorktree(git.integrationWorktree)) return;
    if (await pathExists(git.integrationWorktree)) throw new Error(`integration 路径存在但不是有效 worktree: ${git.integrationWorktree}`);
    await ensurePrivateDir(dirname(git.integrationWorktree));
    await this.gitCommand(git.repoRoot, ["worktree", "prune"]);
    if (!(await this.branchExists(git.integrationBranch))) throw new Error(`恢复失败：缺少 integration branch ${git.integrationBranch}`);
    await this.mustGit(git.repoRoot, ["worktree", "add", git.integrationWorktree, git.integrationBranch]);
  }

  async createTaskWorktree(task: Subtask): Promise<{ path: string; branch: string }> {
    const git = this.requireGit();
    const path = join(dirname(git.integrationWorktree), task.id);
    const branch = `swarm/${this.runId}/${task.id}`;
    if (await this.isWorktree(path)) return { path, branch };
    if (await pathExists(path)) throw new Error(`worker 路径存在但不是有效 worktree: ${path}`);
    await this.gitCommand(git.repoRoot, ["worktree", "prune"]);
    if (await this.branchExists(branch)) {
      await this.mustGit(git.repoRoot, ["worktree", "add", path, branch]);
      return { path, branch };
    }
    const from = (await this.mustGit(git.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    await this.mustGit(git.repoRoot, ["worktree", "add", "-b", branch, path, from]);
    return { path, branch };
  }

  async commitTask(task: Subtask, worktree: string): Promise<{ commit: string; files: string[] }> {
    await this.mustGit(worktree, ["add", "-A"]);
    const names = (await this.mustGit(worktree, ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"])).split("\n").filter(Boolean);
    const outside = names.filter((file) => !matchesAnyGlob(file, task.ownedPaths));
    if (outside.length) {
      await this.gitCommand(worktree, ["reset"]);
      throw new Error(`scope violation: ${outside.join(", ")}`);
    }
    if (names.length === 0) return { commit: (await this.mustGit(worktree, ["rev-parse", "HEAD"])).trim(), files: [] };
    await this.mustGit(worktree, ["-c", "user.name=Pi Swarm", "-c", "user.email=pi-swarm@local.invalid", "commit", "-m", `swarm(${task.id}): ${task.title}`]);
    return { commit: (await this.mustGit(worktree, ["rev-parse", "HEAD"])).trim(), files: names };
  }

  async beginCandidate(kind: GitMergeOperation["kind"], operationId: string): Promise<GitMergeOperation> {
    const git = this.requireGit();
    const preMergeSha = (await this.mustGit(git.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    const suffix = sha256(operationId).slice(0, 12);
    const candidateBranch = `swarm/${this.runId}/candidate/${suffix}`;
    const candidateWorktree = join(dirname(git.integrationWorktree), `candidate-${suffix}`);
    if (!(await this.branchExists(candidateBranch))) {
      await this.mustGit(git.repoRoot, ["branch", candidateBranch, preMergeSha]);
    }
    const operation: GitMergeOperation = {
      operationId,
      kind,
      phase: "prepared",
      preMergeSha,
      candidateBranch,
      candidateWorktree,
      subtaskIds: [],
      candidateSha: preMergeSha,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.ensureCandidateWorktree(operation);
    return operation;
  }

  async ensureCandidateWorktree(operation: GitMergeOperation): Promise<void> {
    const git = this.requireGit();
    if (await this.isWorktree(operation.candidateWorktree)) return;
    if (await pathExists(operation.candidateWorktree)) throw new Error(`candidate 路径存在但不是有效 worktree: ${operation.candidateWorktree}`);
    await this.gitCommand(git.repoRoot, ["worktree", "prune"]);
    if (!(await this.branchExists(operation.candidateBranch))) throw new Error(`缺少 candidate branch ${operation.candidateBranch}`);
    await this.mustGit(git.repoRoot, ["worktree", "add", operation.candidateWorktree, operation.candidateBranch]);
  }

  async mergeTask(task: Subtask, branch: string, operation: GitMergeOperation): Promise<{ ok: boolean; conflicts: string[] }> {
    await this.ensureCandidateWorktree(operation);
    const alreadyMerged = await this.gitCommand(operation.candidateWorktree, ["merge-base", "--is-ancestor", branch, "HEAD"]);
    if (alreadyMerged.exitCode === 0) {
      if (!operation.subtaskIds.includes(task.id)) operation.subtaskIds.push(task.id);
      operation.pendingSubtaskId = undefined;
      operation.phase = "candidate";
      operation.candidateSha = (await this.mustGit(operation.candidateWorktree, ["rev-parse", "HEAD"])).trim();
      operation.updatedAt = Date.now();
      return { ok: true, conflicts: [] };
    }
    operation.pendingSubtaskId = task.id;
    operation.phase = "merging";
    operation.updatedAt = Date.now();
    const mergeHead = await this.gitCommand(operation.candidateWorktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (mergeHead.exitCode === 0) {
      const unresolved = (await this.gitCommand(operation.candidateWorktree, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
      if (!unresolved.length) {
        await this.mustGit(operation.candidateWorktree, ["add", "-A"]);
        await this.mustGit(operation.candidateWorktree, ["-c", "user.name=Pi Swarm", "-c", "user.email=pi-swarm@local.invalid", "commit", "--no-edit"]);
        if (!operation.subtaskIds.includes(task.id)) operation.subtaskIds.push(task.id);
        operation.pendingSubtaskId = undefined;
        operation.phase = "candidate";
        operation.candidateSha = (await this.mustGit(operation.candidateWorktree, ["rev-parse", "HEAD"])).trim();
        operation.updatedAt = Date.now();
        return { ok: true, conflicts: [] };
      }
      return { ok: false, conflicts: unresolved };
    }
    const merge = await this.gitCommand(operation.candidateWorktree, ["-c", "user.name=Pi Swarm", "-c", "user.email=pi-swarm@local.invalid", "merge", "--no-ff", "-m", `merge swarm task ${task.id}`, branch]);
    if (merge.exitCode === 0) {
      if (!operation.subtaskIds.includes(task.id)) operation.subtaskIds.push(task.id);
      operation.pendingSubtaskId = undefined;
      operation.phase = "candidate";
      operation.candidateSha = (await this.mustGit(operation.candidateWorktree, ["rev-parse", "HEAD"])).trim();
      operation.updatedAt = Date.now();
      return { ok: true, conflicts: [] };
    }
    const conflicts = (await this.gitCommand(operation.candidateWorktree, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
    return { ok: false, conflicts };
  }

  async finishConflictMerge(message: string, operation: GitMergeOperation): Promise<void> {
    const unresolved = (await this.gitCommand(operation.candidateWorktree, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
    if (unresolved) throw new Error(`仍有未解决冲突: ${unresolved}`);
    await this.mustGit(operation.candidateWorktree, ["add", "-A"]);
    await this.mustGit(operation.candidateWorktree, ["-c", "user.name=Pi Swarm", "-c", "user.email=pi-swarm@local.invalid", "commit", "-m", message]);
    if (operation.pendingSubtaskId && !operation.subtaskIds.includes(operation.pendingSubtaskId)) operation.subtaskIds.push(operation.pendingSubtaskId);
    operation.pendingSubtaskId = undefined;
    operation.phase = "candidate";
    operation.candidateSha = (await this.mustGit(operation.candidateWorktree, ["rev-parse", "HEAD"])).trim();
    operation.updatedAt = Date.now();
  }

  async commitIntegration(message: string, operation?: GitMergeOperation): Promise<string | undefined> {
    const git = this.requireGit();
    const target = operation?.candidateWorktree ?? git.integrationWorktree;
    await this.mustGit(target, ["add", "-A"]);
    const staged = (await this.mustGit(target, ["diff", "--cached", "--name-only"])).trim();
    if (!staged) return undefined;
    await this.mustGit(target, ["-c", "user.name=Pi Swarm", "-c", "user.email=pi-swarm@local.invalid", "commit", "-m", message]);
    const sha = (await this.mustGit(target, ["rev-parse", "HEAD"])).trim();
    if (operation) operation.candidateSha = sha, (operation.updatedAt = Date.now());
    return sha;
  }

  async abortMerge(operation: GitMergeOperation): Promise<void> {
    await this.gitCommand(operation.candidateWorktree, ["merge", "--abort"]);
  }

  async promoteCandidate(operation: GitMergeOperation): Promise<string> {
    const git = this.requireGit();
    await this.ensureCandidateWorktree(operation);
    const candidateSha = (await this.mustGit(operation.candidateWorktree, ["rev-parse", "HEAD"])).trim();
    const status = await this.mustGit(operation.candidateWorktree, ["status", "--porcelain=v1", "-uall"]);
    if (status.trim()) throw new Error("candidate 尚有未提交更改，拒绝推进 integration");
    const integrationSha = (await this.mustGit(git.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    if (integrationSha !== candidateSha) {
      if (integrationSha !== operation.preMergeSha) throw new Error(`integration 在候选验证期间漂移: ${integrationSha}`);
      await this.mustGit(git.integrationWorktree, ["merge", "--ff-only", operation.candidateBranch]);
    }
    operation.candidateSha = candidateSha;
    operation.postMergeSha = (await this.mustGit(git.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    operation.phase = "promoted";
    operation.updatedAt = Date.now();
    await this.closeCandidate(operation);
    return operation.postMergeSha;
  }

  async discardCandidate(operation: GitMergeOperation): Promise<void> {
    await this.abortMerge(operation).catch(() => undefined);
    operation.phase = "discarded";
    operation.updatedAt = Date.now();
    await this.closeCandidate(operation);
  }

  async reconcileOperation(run: SwarmRun): Promise<void> {
    const operation = [...(run.gitOperations ?? [])].reverse().find((item) => !["promoted", "discarded"].includes(item.phase));
    if (!operation) return;
    const git = this.requireGit();
    const integrationSha = (await this.mustGit(git.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    if (!(await this.branchExists(operation.candidateBranch))) {
      if (operation.candidateSha && integrationSha === operation.candidateSha) {
        operation.phase = "promoted";
        operation.postMergeSha = integrationSha;
        operation.pendingSubtaskId = undefined;
        for (const id of operation.subtaskIds) {
          if (!run.merged.includes(id)) run.merged.push(id);
          if (run.workers[id]) run.workers[id]!.status = "done";
        }
        const order = new Map(run.plan?.mergeOrder.map((id, index) => [id, index]) ?? []);
        run.merged.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
        operation.updatedAt = Date.now();
        return;
      }
      if (integrationSha !== operation.preMergeSha) throw new Error(`candidate 丢失且 integration 已漂移: ${operation.operationId}`);
      operation.phase = "discarded";
      operation.updatedAt = Date.now();
      return;
    }
    const candidateSha = (await this.mustGit(git.repoRoot, ["rev-parse", operation.candidateBranch])).trim();
    operation.candidateSha = candidateSha;
    if (integrationSha === candidateSha || (await this.gitCommand(git.repoRoot, ["merge-base", "--is-ancestor", candidateSha, integrationSha])).exitCode === 0) {
      operation.phase = "promoted";
      operation.postMergeSha = integrationSha;
      operation.pendingSubtaskId = undefined;
      for (const id of operation.subtaskIds) {
        if (!run.merged.includes(id)) run.merged.push(id);
        if (run.workers[id]) run.workers[id]!.status = "done";
      }
      const order = new Map(run.plan?.mergeOrder.map((id, index) => [id, index]) ?? []);
      run.merged.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
      await this.closeCandidate(operation);
      return;
    }
    if (integrationSha !== operation.preMergeSha) throw new Error(`恢复时检测到 integration 漂移: ${operation.operationId}`);
    await this.ensureCandidateWorktree(operation);
    for (const [id, worker] of Object.entries(run.workers)) {
      if (!(await this.branchExists(worker.branch))) continue;
      const branchSha = (await this.mustGit(git.repoRoot, ["rev-parse", worker.branch])).trim();
      if (branchSha === operation.preMergeSha) continue;
      const included = await this.gitCommand(git.repoRoot, ["merge-base", "--is-ancestor", worker.branch, operation.candidateBranch]);
      if (included.exitCode === 0 && !operation.subtaskIds.includes(id)) operation.subtaskIds.push(id);
    }
    if (operation.pendingSubtaskId && operation.subtaskIds.includes(operation.pendingSubtaskId)) operation.pendingSubtaskId = undefined;
    operation.phase = operation.pendingSubtaskId ? "merging" : "candidate";
    operation.updatedAt = Date.now();
  }

  async land(strategy: MergeStrategy): Promise<{ outcome: "applied" | "branch" | "committed"; note: string }> {
    const git = this.requireGit();
    if (strategy === "branch") return { outcome: "branch", note: `结果保留在 ${git.integrationBranch}` };
    const currentHead = (await this.mustGit(git.repoRoot, ["rev-parse", "HEAD"])).trim();
    const currentStatus = await this.mustGit(git.repoRoot, ["status", "--porcelain=v1", "-uall"]);
    if (git.dirtyBase || currentHead !== git.initialHead || sha256(currentStatus) !== git.initialStatusHash) {
      return { outcome: "branch", note: `主工作区在运行期间有状态或 HEAD 漂移，已安全降级为分支 ${git.integrationBranch}` };
    }
    await this.mustGit(git.repoRoot, ["merge", "--squash", git.integrationBranch]);
    if (strategy === "commit") {
      await this.mustGit(git.repoRoot, ["-c", "user.name=Pi Swarm", "-c", "user.email=pi-swarm@local.invalid", "commit", "-m", `swarm: ${this.runId}`]);
      return { outcome: "committed", note: "已生成 squash commit" };
    }
    return { outcome: "applied", note: "结果已暂存，请用 git diff --staged 审阅" };
  }

  async cleanupWorktrees(preserveBranches = true): Promise<void> {
    const git = this.requireGit();
    const root = dirname(git.integrationWorktree);
    const list = await this.gitCommand(git.repoRoot, ["worktree", "list", "--porcelain"]);
    const paths = list.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)).filter((path) => resolve(path).startsWith(`${resolve(root)}/`) || resolve(path) === resolve(root));
    for (const path of paths) await this.gitCommand(git.repoRoot, ["worktree", "remove", "--force", path]);
    await this.gitCommand(git.repoRoot, ["worktree", "prune"]);
    if (!preserveBranches) {
      const branches = (await this.gitCommand(git.repoRoot, ["branch", "--list", `swarm/${this.runId}/*`])).stdout.split("\n").map((line) => line.replace(/^\*?\s*/, "")).filter(Boolean);
      for (const branch of branches) await this.gitCommand(git.repoRoot, ["branch", "-D", branch]);
    }
  }

  async reconcileMerged(run: SwarmRun): Promise<void> {
    const git = this.requireGit();
    for (const [id, worker] of Object.entries(run.workers)) {
      if (run.merged.includes(id)) continue;
      if (!worker.verification?.ok || !["merging", "done"].includes(worker.status)) continue;
      if (!(await this.branchExists(worker.branch))) continue;
      const branchSha = (await this.mustGit(git.repoRoot, ["rev-parse", worker.branch])).trim();
      if (branchSha === git.baseCommit) continue;
      const ancestor = await this.gitCommand(git.repoRoot, ["merge-base", "--is-ancestor", worker.branch, git.integrationBranch]);
      if (ancestor.exitCode === 0) run.merged.push(id), (worker.status = "done");
    }
  }

  private async closeCandidate(operation: GitMergeOperation): Promise<void> {
    const git = this.requireGit();
    if (await this.isWorktree(operation.candidateWorktree)) await this.gitCommand(git.repoRoot, ["worktree", "remove", "--force", operation.candidateWorktree]);
    if (await this.branchExists(operation.candidateBranch)) await this.gitCommand(git.repoRoot, ["branch", "-D", operation.candidateBranch]);
    await this.gitCommand(git.repoRoot, ["worktree", "prune"]);
  }

  private async createTemporaryBaseline(repoRoot: string, parent: string): Promise<string> {
    const baselineRoot = dirname(this.runDir);
    await ensurePrivateDir(baselineRoot);
    const tempRoot = await mkdtemp(join(baselineRoot, ".baseline-"));
    const indexPath = join(tempRoot, "index");
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await this.mustGit(repoRoot, ["add", "-A"], env);
      const tree = (await this.mustGit(repoRoot, ["write-tree"], env)).trim();
      return (await this.mustGit(repoRoot, ["commit-tree", tree, "-p", parent, "-m", "swarm temporary baseline"], env)).trim();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private requireGit(): GitRunState {
    if (!this.git) throw new Error("workspace 尚未 prepare/restore");
    return this.git;
  }

  private async isWorktree(path: string): Promise<boolean> {
    if (!(await pathExists(path))) return false;
    const result = await this.gitCommand(path, ["rev-parse", "--is-inside-work-tree"]);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  private async branchExists(branch: string): Promise<boolean> {
    const git = this.requireGit();
    const result = await this.gitCommand(git.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return result.exitCode === 0;
  }

  private async mustGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.gitCommand(cwd, args, env);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }

  private gitCommand(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
    return runCommand("git", args, { cwd, env, timeoutMs: 120_000 });
  }
}
