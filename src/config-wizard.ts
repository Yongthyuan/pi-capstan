/**
 * Interactive configuration wizard for pi-swarm
 *
 * Guides users through creating project-specific swarm configurations
 * by asking questions about their use case, constraints, and preferences.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SwarmConfig } from "./types.js";

export interface WizardAnswers {
  useCase: "large-refactor" | "production-feature" | "untrusted-code" | "fast-iteration" | "custom";
  maxBudget?: number;
  qualityLevel: "fast" | "balanced" | "high";
  verification: "minimal" | "standard" | "comprehensive";
}

/**
 * Generate swarm configuration based on wizard answers
 */
export function generateConfigFromAnswers(answers: WizardAnswers): Partial<SwarmConfig> {
  const config: any = {};

  // Use case presets (only override specific fields)
  switch (answers.useCase) {
    case "large-refactor":
      config.planner = { maxSubtasks: 12, budgetUsd: 2, repoMapTokens: 8000 };
      config.worker = { maxConcurrency: 6, perAgentBudgetUsd: 3, maxRetries: 1, bestOfN: 1 };
      config.run = { budgetUsd: answers.maxBudget ?? 30, failurePolicy: "continue-independent", mergeStrategy: "branch" };
      break;

    case "production-feature":
      config.worker = { bestOfN: 2, bestOfNJudge: true, maxRetries: 2, perAgentBudgetUsd: 3 };
      config.run = { budgetUsd: answers.maxBudget ?? 15, mergeStrategy: "branch", failurePolicy: "fail-fast" };
      break;

    case "untrusted-code":
      config.worker = {
        strictBash: true,
        scopeViolationPolicy: "fail",
        tools: ["read", "grep", "find", "ls", "swarm_send", "swarm_inbox"],
        maxRetries: 1,
      };
      config.run = { budgetUsd: answers.maxBudget ?? 10, mergeStrategy: "branch" };
      break;

    case "fast-iteration":
      config.planner = { maxSubtasks: 4, budgetUsd: 0.5, repoMapTokens: 3000 };
      config.worker = { maxConcurrency: 8, perAgentBudgetUsd: 1, bestOfN: 1, maxRetries: 1 };
      config.run = { budgetUsd: answers.maxBudget ?? 5, mergeStrategy: "branch", failurePolicy: "continue-independent" };
      break;
  }

  // Quality adjustments
  if (answers.qualityLevel === "high") {
    config.worker = { ...(config.worker || {}), bestOfN: 3, bestOfNJudge: true, maxRetries: 3 };
    if (config.run) config.run.budgetUsd = (config.run.budgetUsd ?? 8) * 1.5;
  } else if (answers.qualityLevel === "fast") {
    config.worker = { ...(config.worker || {}), bestOfN: 1, maxRetries: 1 };
    if (config.run) config.run.budgetUsd = (config.run.budgetUsd ?? 8) * 0.7;
  }

  // Verification level
  if (!config.run) config.run = {};
  if (answers.verification === "minimal") {
    config.run.verify = { worker: null, integrationLight: null, full: null };
  } else if (answers.verification === "standard") {
    config.run.verify = {
      worker: ["npm run typecheck", "npm test -- --passWithNoTests"],
      integrationLight: null,
      full: null,
    };
  } else if (answers.verification === "comprehensive") {
    config.run.verify = {
      worker: ["npm run typecheck", "npm test -- --passWithNoTests"],
      integrationLight: ["npm run lint"],
      full: ["npm test -- --coverage"],
    };
  }

  return config as Partial<SwarmConfig>;
}

/**
 * Describe the generated configuration in human-readable form
 */
export function describeConfig(config: Partial<SwarmConfig>, answers: WizardAnswers): string {
  const lines: string[] = ["📋 生成的配置：\n"];

  lines.push(`任务类型: ${answers.useCase}`);

  if (config.planner) {
    lines.push(`\n🧠 Planner:`);
    if (config.planner.maxSubtasks) lines.push(`  - 最多 ${config.planner.maxSubtasks} 个子任务`);
    if (config.planner.budgetUsd) lines.push(`  - 预算: $${config.planner.budgetUsd}`);
  }

  if (config.worker) {
    lines.push(`\n⚙️  Worker:`);
    if (config.worker.maxConcurrency) lines.push(`  - 并发度: ${config.worker.maxConcurrency}`);
    if (config.worker.bestOfN) lines.push(`  - Best-of-N: ${config.worker.bestOfN}`);
    if (config.worker.maxRetries) lines.push(`  - 最大重试: ${config.worker.maxRetries}`);
    if (config.worker.perAgentBudgetUsd) lines.push(`  - 每个 agent 预算: $${config.worker.perAgentBudgetUsd}`);
  }

  if (config.run) {
    lines.push(`\n🏃 Run:`);
    if (config.run.budgetUsd) lines.push(`  - 总预算: $${config.run.budgetUsd}`);
    if (config.run.mergeStrategy) lines.push(`  - 合并策略: ${config.run.mergeStrategy}`);
    if (config.run.failurePolicy) lines.push(`  - 失败策略: ${config.run.failurePolicy}`);
    if (config.run.verify) {
      const hasWorker = config.run.verify.worker && config.run.verify.worker.length > 0;
      const hasIntegration = config.run.verify.integrationLight && config.run.verify.integrationLight.length > 0;
      const hasFull = config.run.verify.full && config.run.verify.full.length > 0;
      if (hasWorker || hasIntegration || hasFull) {
        lines.push(`  - 验证: ${hasWorker ? 'worker' : ''}${hasIntegration ? '+integration' : ''}${hasFull ? '+full' : ''}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Write configuration to file with helpful comments
 */
export function writeConfigWithComments(
  filePath: string,
  config: Partial<SwarmConfig>,
  answers: WizardAnswers
): void {
  const comment = `// Pi-Swarm 配置
// 用例: ${answers.useCase}
// 质量级别: ${answers.qualityLevel}
// 验证级别: ${answers.verification}
//
// 查看 docs/CONFIGURATION.md 了解所有选项

`;

  const content = comment + JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
}
