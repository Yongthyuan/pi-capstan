import type { SwarmRun, VerificationResult } from "./types.ts";

export function buildReport(run: SwarmRun, finalVerification?: VerificationResult, landingNote?: string): string {
  const workers = Object.values(run.workers);
  const lines = [
    `# Swarm ${run.phase === "done" ? "完成" : "结束"} · ${run.plan?.taskSummary ?? run.task}`,
    "",
    `- runId: \`${run.runId}\``,
    `- 状态: ${run.phase}`,
    `- 落地: ${run.outcome ?? "未落地"}${landingNote ? `（${landingNote}）` : ""}`,
    `- 用时: ${formatDuration(run.totals.wallSec)} · 成本: $${run.totals.cost.toFixed(4)} · tokens: ${run.totals.input + run.totals.output}`,
    "",
    "## 子任务",
    "",
    "| id | 标题 | 状态 | 重试 | tokens | 成本 |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const worker of workers) {
    const task = run.plan?.subtasks.find((item) => item.id === worker.subtaskId);
    lines.push(`| ${worker.subtaskId} | ${escapeCell(task?.title ?? worker.subtaskId)} | ${worker.status} | ${worker.retries} | ${worker.usage.input + worker.usage.output} | $${worker.usage.cost.toFixed(4)} |`);
  }
  lines.push("", "## 验证", "");
  for (const worker of workers) {
    const verification = worker.verification;
    lines.push(`- ${worker.subtaskId}: ${verification?.ok ? "✓" : "✗"} ${verification?.commands.map((item) => `\`${item.command}\``).join(", ") || "无命令"}`);
  }
  if (finalVerification) lines.push(`- 集成全量: ${finalVerification.ok ? "✓" : "✗"} ${finalVerification.commands.map((item) => `\`${item.command}\``).join(", ") || "无命令"}`);
  if (run.conflicts.length) {
    lines.push("", "## 冲突", "");
    for (const conflict of run.conflicts) lines.push(`- ${conflict.incomingSubtask}: ${conflict.files.join(", ")} · ${conflict.resolved ? "已仲裁" : "未解决"}`);
  }
  const notes = workers.filter((worker) => Boolean(worker.completionReport)).map((worker) => ({ id: worker.subtaskId, report: worker.completionReport! }));
  if (notes.length) {
    lines.push("", "## Worker 完工摘要", "");
    for (const note of notes) lines.push(`### ${note.id}`, "", note.report.slice(0, 2000), "");
  }
  if (run.error) lines.push("", "## 错误", "", run.error);
  if (run.caseId) lines.push("", `反馈：\`/swarm cases rate ${run.caseId} +1|-1\``);
  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins ? `${mins}m${secs}s` : `${secs}s`;
}
