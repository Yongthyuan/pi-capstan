/**
 * Interactive configuration wizard for pi-swarm.
 *
 * Guides users through creating project-specific swarm configurations
 * by asking about use case, constraints, and preferences.
 */

import { writeFileSync } from "node:fs";
import type { SwarmConfig } from "./types.ts";

export interface WizardAnswers {
  useCase: "large-refactor" | "production-feature" | "untrusted-code" | "fast-iteration" | "custom";
  maxBudget?: number;
  qualityLevel: "fast" | "balanced" | "high";
  verification: "minimal" | "standard" | "comprehensive";
}

/**
 * Generate swarm configuration based on wizard answers.
 * Returns a partial config suitable for deep-merge into defaults.
 */
export function generateConfigFromAnswers(answers: WizardAnswers): Partial<SwarmConfig> {
  const config: Record<string, unknown> = {};

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

  const run = (config.run ??= {}) as Record<string, unknown>;
  const worker = (config.worker ??= {}) as Record<string, unknown>;

  if (answers.qualityLevel === "high") {
    Object.assign(worker, { bestOfN: 3, bestOfNJudge: true, maxRetries: 3 });
    run.budgetUsd = ((run.budgetUsd as number | undefined) ?? 8) * 1.5;
  } else if (answers.qualityLevel === "fast") {
    Object.assign(worker, { bestOfN: 1, maxRetries: 1 });
    run.budgetUsd = ((run.budgetUsd as number | undefined) ?? 8) * 0.7;
  }

  if (answers.verification === "minimal") {
    run.verify = { worker: null, integrationLight: null, full: null };
  } else if (answers.verification === "standard") {
    run.verify = {
      worker: ["npm run typecheck", "npm test -- --passWithNoTests"],
      integrationLight: null,
      full: null,
    };
  } else if (answers.verification === "comprehensive") {
    run.verify = {
      worker: ["npm run typecheck", "npm test -- --passWithNoTests"],
      integrationLight: ["npm run lint"],
      full: ["npm test -- --coverage"],
    };
  }

  return config as Partial<SwarmConfig>;
}

export function describeConfig(config: Partial<SwarmConfig>, answers: WizardAnswers): string {
  const lines: string[] = ["Generated configuration:\n"];
  lines.push(`Use case: ${answers.useCase}`);

  if (config.planner) {
    lines.push("\nPlanner:");
    if (config.planner.maxSubtasks) lines.push(`  - max subtasks: ${config.planner.maxSubtasks}`);
    if (config.planner.budgetUsd) lines.push(`  - budget: $${config.planner.budgetUsd}`);
  }

  if (config.worker) {
    lines.push("\nWorker:");
    if (config.worker.maxConcurrency) lines.push(`  - concurrency: ${config.worker.maxConcurrency}`);
    if (config.worker.bestOfN) lines.push(`  - best-of-N: ${config.worker.bestOfN}`);
    if (config.worker.maxRetries) lines.push(`  - max retries: ${config.worker.maxRetries}`);
    if (config.worker.perAgentBudgetUsd) lines.push(`  - per-agent budget: $${config.worker.perAgentBudgetUsd}`);
  }

  if (config.run) {
    lines.push("\nRun:");
    if (config.run.budgetUsd) lines.push(`  - total budget: $${config.run.budgetUsd}`);
    if (config.run.mergeStrategy) lines.push(`  - merge strategy: ${config.run.mergeStrategy}`);
    if (config.run.failurePolicy) lines.push(`  - failure policy: ${config.run.failurePolicy}`);
  }

  lines.push(`\nQuality: ${answers.qualityLevel}`);
  lines.push(`Verification: ${answers.verification}`);
  return lines.join("\n");
}

/**
 * Write valid JSON only (loadConfig cannot parse comment prefixes).
 * Metadata is stored under `$wizard` for human/agent context.
 */
export function writeConfigWithComments(
  filePath: string,
  config: Partial<SwarmConfig>,
  answers: WizardAnswers,
): void {
  const payload = {
    $wizard: {
      useCase: answers.useCase,
      qualityLevel: answers.qualityLevel,
      verification: answers.verification,
      generatedAt: new Date().toISOString(),
      docs: "docs/CONFIGURATION.md",
    },
    ...config,
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
