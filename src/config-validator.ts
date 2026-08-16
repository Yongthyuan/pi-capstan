import type { SwarmConfig } from "./types.ts";

export interface ValidationIssue {
  path: string;
  level: "error" | "warning" | "info";
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateConfig(config: SwarmConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Gate 验证
  if (config.gate.ruleThresholdHigh <= config.gate.ruleThresholdLow) {
    issues.push({
      path: "gate.ruleThresholdHigh",
      level: "error",
      message: `ruleThresholdHigh (${config.gate.ruleThresholdHigh}) 必须大于 ruleThresholdLow (${config.gate.ruleThresholdLow})`,
      suggestion: `设置 ruleThresholdHigh 为 ${config.gate.ruleThresholdLow + 5}`,
    });
  }

  if (config.gate.ruleThresholdHigh < 1 || config.gate.ruleThresholdHigh > 100) {
    issues.push({
      path: "gate.ruleThresholdHigh",
      level: "warning",
      message: `ruleThresholdHigh (${config.gate.ruleThresholdHigh}) 超出推荐范围 [1, 100]`,
    });
  }

  // Planner 验证
  if (config.planner.maxSubtasks < 1 || config.planner.maxSubtasks > 50) {
    issues.push({
      path: "planner.maxSubtasks",
      level: "warning",
      message: `maxSubtasks (${config.planner.maxSubtasks}) 超出推荐范围 [1, 50]`,
      suggestion: "过大会导致规划复杂度失控，过小限制并行能力",
    });
  }

  if (config.planner.budgetUsd <= 0) {
    issues.push({
      path: "planner.budgetUsd",
      level: "error",
      message: `budgetUsd (${config.planner.budgetUsd}) 必须为正数`,
      suggestion: "设置为 5-20 美元",
    });
  }

  if (config.planner.tokenLimit < 10000) {
    issues.push({
      path: "planner.tokenLimit",
      level: "warning",
      message: `tokenLimit (${config.planner.tokenLimit}) 过低，可能导致规划不完整`,
      suggestion: "推荐至少 50000",
    });
  }

  // Worker 验证
  if (config.worker.maxConcurrency < 1) {
    issues.push({
      path: "worker.maxConcurrency",
      level: "error",
      message: `maxConcurrency (${config.worker.maxConcurrency}) 必须至少为 1`,
      suggestion: "设置为 2-8",
    });
  }

  if (config.worker.maxConcurrency > 16) {
    issues.push({
      path: "worker.maxConcurrency",
      level: "warning",
      message: `maxConcurrency (${config.worker.maxConcurrency}) 过高，可能导致资源竞争`,
      suggestion: "推荐不超过 8",
    });
  }

  if (config.worker.perAgentBudgetUsd <= 0) {
    issues.push({
      path: "worker.perAgentBudgetUsd",
      level: "error",
      message: `perAgentBudgetUsd (${config.worker.perAgentBudgetUsd}) 必须为正数`,
      suggestion: "设置为 1-5 美元",
    });
  }

  if (config.worker.stallSec < 60) {
    issues.push({
      path: "worker.stallSec",
      level: "warning",
      message: `stallSec (${config.worker.stallSec}) 过短，可能误判正常工作为停滞`,
      suggestion: "推荐至少 120 秒",
    });
  }

  // Run 验证
  if (config.run.budgetUsd && config.run.budgetUsd < config.planner.budgetUsd + config.worker.perAgentBudgetUsd * 2) {
    issues.push({
      path: "run.budgetUsd",
      level: "warning",
      message: `run.budgetUsd (${config.run.budgetUsd}) 小于 planner + 2 workers 的最小成本`,
      suggestion: `至少设置为 ${config.planner.budgetUsd + config.worker.perAgentBudgetUsd * 2}`,
    });
  }

  // Verification 验证
  if (config.run.verifyTimeoutSec < 30) {
    issues.push({
      path: "run.verifyTimeoutSec",
      level: "warning",
      message: `verifyTimeoutSec (${config.run.verifyTimeoutSec}) 过短`,
      suggestion: "推荐至少 60 秒",
    });
  }

  // Merge 验证
  if (config.run.mergeStrategy !== "branch" && config.run.mergeStrategy !== "apply" && config.run.mergeStrategy !== "commit") {
    issues.push({
      path: "run.mergeStrategy",
      level: "error",
      message: `mergeStrategy (${config.run.mergeStrategy}) 无效`,
      suggestion: "必须是 'branch', 'apply', 或 'commit'",
    });
  }

  // Bash / tools 验证
  if (!config.worker.tools.includes("bash")) {
    issues.push({
      path: "worker.tools",
      level: "info",
      message: "worker.tools 未包含 bash，workers 无法执行 shell 命令",
    });
  }

  // 预算一致性检查
  const plannerCost = config.planner.budgetUsd;
  const maxWorkersCost = config.worker.perAgentBudgetUsd * config.planner.maxSubtasks;
  const totalEstimated = plannerCost + maxWorkersCost;

  if (config.run.budgetUsd && config.run.budgetUsd < totalEstimated) {
    issues.push({
      path: "run.budgetUsd",
      level: "info",
      message: `run.budgetUsd (${config.run.budgetUsd}) 小于最坏情况成本 (${totalEstimated.toFixed(2)})`,
      suggestion: "如果所有子任务都耗尽预算，run 会提前终止",
    });
  }

  return {
    valid: issues.filter(i => i.level === "error").length === 0,
    issues,
  };
}

export function formatValidationResult(result: ValidationResult): string {
  if (result.valid && result.issues.length === 0) {
    return "✓ 配置验证通过，无问题";
  }

  const lines: string[] = [];

  if (!result.valid) {
    lines.push("✗ 配置验证失败\n");
  } else {
    lines.push("⚠ 配置验证通过，但有警告\n");
  }

  const errors = result.issues.filter(i => i.level === "error");
  const warnings = result.issues.filter(i => i.level === "warning");
  const infos = result.issues.filter(i => i.level === "info");

  if (errors.length > 0) {
    lines.push("错误:");
    for (const issue of errors) {
      lines.push(`  • ${issue.path}: ${issue.message}`);
      if (issue.suggestion) lines.push(`    建议: ${issue.suggestion}`);
    }
  }

  if (warnings.length > 0) {
    if (errors.length > 0) lines.push("");
    lines.push("警告:");
    for (const issue of warnings) {
      lines.push(`  • ${issue.path}: ${issue.message}`);
      if (issue.suggestion) lines.push(`    建议: ${issue.suggestion}`);
    }
  }

  if (infos.length > 0) {
    if (errors.length > 0 || warnings.length > 0) lines.push("");
    lines.push("信息:");
    for (const issue of infos) {
      lines.push(`  • ${issue.path}: ${issue.message}`);
      if (issue.suggestion) lines.push(`    ${issue.suggestion}`);
    }
  }

  return lines.join("\n");
}

export function autoFixConfig(config: SwarmConfig): { fixed: SwarmConfig; changes: string[] } {
  const fixed = JSON.parse(JSON.stringify(config)) as SwarmConfig;
  const changes: string[] = [];

  // 修复 gate thresholds
  if (fixed.gate.ruleThresholdHigh <= fixed.gate.ruleThresholdLow) {
    fixed.gate.ruleThresholdHigh = fixed.gate.ruleThresholdLow + 5;
    changes.push(`gate.ruleThresholdHigh 设置为 ${fixed.gate.ruleThresholdHigh}`);
  }

  // 修复 planner budget
  if (fixed.planner.budgetUsd <= 0) {
    fixed.planner.budgetUsd = 10;
    changes.push("planner.budgetUsd 设置为 10");
  }

  // 修复 worker concurrency
  if (fixed.worker.maxConcurrency < 1) {
    fixed.worker.maxConcurrency = 4;
    changes.push("worker.maxConcurrency 设置为 4");
  }

  if (fixed.worker.maxConcurrency > 16) {
    fixed.worker.maxConcurrency = 8;
    changes.push("worker.maxConcurrency 降低到 8");
  }

  // 修复 worker budget
  if (fixed.worker.perAgentBudgetUsd <= 0) {
    fixed.worker.perAgentBudgetUsd = 2;
    changes.push("worker.perAgentBudgetUsd 设置为 2");
  }

  // 修复 merge strategy
  if (fixed.run.mergeStrategy !== "branch" && fixed.run.mergeStrategy !== "apply" && fixed.run.mergeStrategy !== "commit") {
    fixed.run.mergeStrategy = "branch";
    changes.push("run.mergeStrategy 设置为 'branch'");
  }

  return { fixed, changes };
}
