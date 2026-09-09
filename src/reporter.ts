import type { CapstanRun, GitMergeOperation, VerificationResult } from "./types.ts";

export function buildReport(run: CapstanRun, finalVerification: VerificationResult | undefined = run.finalVerification, landingNote?: string): string {
  const workers = Object.values(run.workers);
  const statusLabel = run.phase === "done"
    ? (run.partialSuccess ? "部分完成" : "完成")
    : "结束";
  const evidence = assessDelivery(run, finalVerification);
  const lines = [
    `# Capstan 交付报告 · ${statusLabel} · ${run.plan?.taskSummary ?? run.task}`,
    "",
    `**结论**: ${evidence.verdict}`,
    `- runId: \`${run.runId}\``,
    `- 状态: ${run.phase} · plan revision ${run.planRevision ?? 1}`,
    `- 落地: ${run.outcome ?? "未落地"}${landingNote ? `（${landingNote}）` : ""}`,
    `- 用时: ${formatDuration(run.totals.wallSec)} · 成本: $${run.totals.cost.toFixed(4)} · tokens: ${run.totals.input + run.totals.output}`,
    `- 剩余风险: ${evidence.risks.join("；") || "所列检查通过，仍需代码审查"}`,
    "",
    "## 事务日志",
    "",
  ];
  const ops = run.gitOperations ?? [];
  if (!ops.length) {
    lines.push("_（本 run 无 candidate 晋升记录 — 可能为 plan-only 或尚未进入建造阶段）_", "");
  } else {
    for (const op of ops) lines.push(...formatOperation(op, run));
  }
  if (run.git) {
    lines.push(`- last-green / integration: \`${run.git.integrationBranch}\` @ base \`${shortSha(run.git.baseCommit)}\``);
    lines.push(`- 已晋升任务: ${run.merged.length ? run.merged.join(", ") : "（无）"}`, "");
  }

  lines.push("## 每任务验收", "");
  lines.push("| id | 标题 | 状态 | 验证 | 重试 | tokens | 成本 | 越界回滚 |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|");
  for (const worker of workers) {
    const task = run.plan?.subtasks.find((item) => item.id === worker.subtaskId);
    const verification = worker.verification;
    const mark = verification?.skipped ? "跳过" : verification?.ok ? "✔" : verification ? "✘" : "—";
    const cmds = verification?.commands.map((item) => `\`${item.command}\`→${item.exitCode}`).join("; ") || "—";
    const reverted = worker.revertedScopePaths?.length ?? 0;
    lines.push(
      `| ${worker.subtaskId} | ${escapeCell(task?.title ?? worker.subtaskId)} | ${worker.status} | ${mark} ${escapeCell(cmds)} | ${worker.retries} | ${worker.usage.input + worker.usage.output} | $${worker.usage.cost.toFixed(4)} | ${reverted} |`,
    );
  }

  const recoveredScope = workers.filter((worker) => worker.revertedScopePaths?.length);
  if (recoveredScope.length) {
    lines.push("", "## Scope 自动回收", "");
    for (const worker of recoveredScope) lines.push(`- ${worker.subtaskId}: ${worker.revertedScopePaths!.join(", ")}`);
  }

  lines.push("", "## 最终验证", "");
  if (finalVerification) {
    const mark = finalVerification.skipped ? "跳过" : finalVerification.ok ? "✔" : "✘";
    for (const item of finalVerification.commands) {
      lines.push(`- ${mark} \`${item.command}\` · exit ${item.exitCode} · ${(item.durationMs / 1000).toFixed(1)}s`);
    }
    if (!finalVerification.commands.length) lines.push(`- ${mark}（无命令）`);
  } else {
    lines.push("- （尚未跑 full lane）");
  }

  if (run.conflicts.length) {
    lines.push("", "## 冲突", "");
    for (const conflict of run.conflicts) {
      lines.push(`- ${conflict.incomingSubtask}: ${conflict.files.join(", ")} · ${conflict.resolved ? "已仲裁" : "未解决"}`);
    }
  }

  const notes = workers.filter((worker) => Boolean(worker.completionReport)).map((worker) => ({ id: worker.subtaskId, report: worker.completionReport! }));
  if (notes.length) {
    lines.push("", "## Worker 完工摘要", "");
    for (const note of notes) lines.push(`### ${note.id}`, "", note.report.slice(0, 2000), "");
  }
  if (run.error) lines.push("", "## 错误", "", run.error);
  if (run.caseId) lines.push("", `反馈：\`/capstan cases rate ${run.caseId} +1|-1\``);
  return redactPublicText(`${lines.join("\n")}\n`, run);
}

/** Proof-Carrying PR body — no local paths, no raw log dumps. */
export function buildProofCarryingPrBody(run: CapstanRun): string {
  const workers = Object.values(run.workers);
  const evidence = assessDelivery(run, run.finalVerification);
  const lines = [
    `## Capstan Proof-Carrying Delivery`,
    "",
    `**Run** \`${run.runId}\` · ${evidence.status} · $${run.totals.cost.toFixed(4)} · ${formatDuration(run.totals.wallSec)}`,
    "",
    "This PR contains the promoted integration branch. Verification evidence is recorded below; skipped or missing checks are not a verified pass.",
    `Verdict: ${evidence.verdict}`,
    ...(evidence.risks.length ? [`Review required: ${evidence.risks.join("; ")}`] : []),
    "",
    "### Transaction log",
    "",
  ];
  const ops = run.gitOperations ?? [];
  if (!ops.length) {
    lines.push("- (no candidate operations recorded)");
  } else {
    for (const op of ops) {
      lines.push(...formatOperation(op, run));
    }
  }
  lines.push("", "### Per-task evidence", "");
  for (const worker of workers) {
    const task = run.plan?.subtasks.find((item) => item.id === worker.subtaskId);
    const cmds = worker.verification?.commands.map((c) => `\`${c.command}\` (exit ${c.exitCode})`).join(", ") || "none";
    lines.push(
      `- **${worker.subtaskId}** — ${task?.title ?? worker.subtaskId}`,
      `  - status: ${worker.status} · retries: ${worker.retries} · cost: $${worker.usage.cost.toFixed(4)}`,
      `  - goal: ${truncateOneLine(task?.goal ?? "", 160)}`,
      `  - verification: ${verificationLabel(worker.verification)} · ${cmds}`,
      `  - landed: ${run.merged.includes(worker.subtaskId) ? "yes" : "no"}`,
    );
    if (worker.revertedScopePaths?.length) {
      lines.push(`  - scope revert: ${worker.revertedScopePaths.join(", ")}`);
    }
  }
  lines.push("", "### Final integration verification", "", `- ${verificationLabel(run.finalVerification)}`);
  for (const command of run.finalVerification?.commands ?? []) lines.push(`- \`${command.command}\` (exit ${command.exitCode})`);
  lines.push(
    "",
    "### How to re-check",
    "",
    "```bash",
    `# Compare this PR's commits against the pre-capstan base (adjust SHAs as needed)`,
    `git range-diff ${run.git?.baseCommit ?? "BASE"}...HEAD`,
    "```",
    "",
    "_Local RPC logs, sessions, and full reports were not uploaded by `/capstan pr`._",
    "",
  );
  return redactPublicText(`${lines.join("\n")}\n`, run);
}

function formatOperation(op: GitMergeOperation, run: CapstanRun): string[] {
  const mark = op.phase === "promoted" ? "✔" : op.phase === "discarded" ? "✘" : "·";
  const commands = op.verification?.commands.map((c) => `\`${c.command}\` exit ${c.exitCode} (${(c.durationMs / 1000).toFixed(1)}s)`).join(", ");
  const verify = `${verificationLabel(op.verification)}${commands ? ` · ${commands}` : ""}`;
  const lines = [
    `- ${mark} **${op.kind}** \`${op.operationId}\` · \`${op.phase}\``,
    `  - base → candidate: \`${shortSha(op.preMergeSha)}\` → \`${shortSha(op.candidateSha ?? op.candidateBranch)}\``,
    `  - merged into candidate: ${op.subtaskIds.join(", ") || "—"}`,
    `  - verification: ${verify}`,
  ];
  if (op.postMergeSha) lines.push(`  - promoted → \`${shortSha(op.postMergeSha)}\` (last-green)`);
  const relatedConflicts = run.conflicts.filter((c) => op.subtaskIds.includes(c.incomingSubtask));
  for (const conflict of relatedConflicts) {
    lines.push(`  - conflict ${conflict.incomingSubtask}: ${conflict.files.join(", ")} · ${conflict.resolved ? "仲裁通过" : "未解决"}`);
  }
  return lines;
}

function shortSha(value: string): string {
  if (!value) return "—";
  return value.length > 12 && /^[0-9a-f]+$/i.test(value) ? value.slice(0, 7) : value;
}

function truncateOneLine(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins ? `${mins}m${secs}s` : `${secs}s`;
}

function verificationLabel(result?: VerificationResult): string {
  if (!result) return "unknown / 未记录";
  if (result.skipped) return "skipped / 跳过";
  if (!result.commands.length) return "unknown / 无命令证据";
  return result.ok && result.commands.every((command) => command.exitCode === 0 && !command.timedOut && !command.blocked)
    ? "passed / 通过" : "failed / 失败";
}

function isVerified(result?: VerificationResult): boolean {
  return verificationLabel(result).startsWith("passed");
}

function assessDelivery(run: CapstanRun, finalVerification?: VerificationResult) {
  const merged = run.merged ?? [];
  const promoted = (run.gitOperations ?? []).filter((operation) => operation.phase === "promoted");
  const partial = Boolean(run.partialSuccess) || Boolean(run.plan?.subtasks.some((task) => !merged.includes(task.id)));
  const risks: string[] = [];
  if (partial) risks.push("存在未落地任务");
  if (run.conflicts.some((conflict) => !conflict.resolved)) risks.push("存在未解决冲突");
  if (!merged.length) risks.push("没有已晋升任务");
  if (merged.some((id) => !isVerified(run.workers[id]?.verification))) risks.push("任务验证跳过或证据不完整");
  if (!promoted.length || promoted.some((operation) => !isVerified(operation.verification)) || merged.some((id) => !promoted.some((operation) => operation.subtaskIds.includes(id)))) risks.push("候选晋升验证跳过或证据不完整");
  if (!isVerified(finalVerification)) risks.push("最终集成验证未通过、跳过或未记录");
  if (["failed", "aborted"].includes(run.phase)) {
    return { verdict: "未完成 — 不要合入整个 run；已有晋升结果需单独审查", status: run.phase + "; promoted work only", risks };
  }
  if (run.phase !== "done") return { verdict: "进行中 — 尚不能验收", status: run.phase, risks };
  if (risks.length) return {
    verdict: partial ? "部分完成 — 需人工复核后再合入" : "执行完成 — 验证证据不完整，需人工复核",
    status: partial ? "partial; review required" : "complete; verification incomplete",
    risks,
  };
  return { verdict: "完整成功 — 所列检查通过，建议合入前审查", status: "complete; checks passed", risks };
}

/** Scrub every rendered field, including model-authored goals and command args. */
export function redactPublicText(value: string, run?: CapstanRun): string {
  const privatePaths = run ? [
    run.cwd, run.runDir, run.reportPath, run.git?.repoRoot, run.git?.integrationWorktree,
    ...Object.values(run.workers).flatMap((worker) => [worker.worktree, worker.sessionFile, worker.launch?.guardPath, worker.launch?.promptPath, worker.launch?.sessionDir]),
    ...(run.gitOperations ?? []).map((operation) => operation.candidateWorktree),
  ] : [];
  let text = value;
  for (const path of privatePaths.filter((path): path is string => Boolean(path && /^(?:\/|[A-Za-z]:[\\/])/.test(path))).sort((a, b) => b.length - a.length)) {
    text = text.split(path).join("[local-path]");
  }
  return text
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/[A-Za-z]:[\\/][^\s`"'<>|),;]+/g, "[local-path]")
    .replace(/\\\\[^\s`"'<>|),;]+/g, "[local-path]")
    .replace(/\/(?:Users|home|tmp|private|var|Volumes|mnt|etc|opt|srv|root|workspace|workspaces)\/[^\s`"'<>|),;]+/g, "[local-path]");
}
