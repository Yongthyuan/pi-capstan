/**
 * Historical run analyzer — reads persisted SwarmRun state and emits trends /
 * configuration recommendations for agents and humans.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SwarmRun, WorkerRuntime } from "./types.ts";
import { pathExists } from "./utils.ts";

export interface RunSummary {
  runId: string;
  timestamp: number;
  phase: string;
  outcome?: string;
  durationMs: number;
  costUsd: number;
  subtaskCount: number;
  successRate: number;
  conflictRate: number;
  avgRetries: number;
  task: string;
}

export interface TrendAnalysis {
  totalRuns: number;
  dateRange: { from: number; to: number };
  overallSuccessRate: number;
  successRateTrend: "improving" | "declining" | "stable";
  avgCostPerRun: number;
  totalCost: number;
  costTrend: Array<{ date: string; cost: number }>;
  avgDurationMs: number;
  durationTrend: "faster" | "slower" | "stable";
  avgConflictRate: number;
  avgRetryRate: number;
  commonFailures: Array<{ pattern: string; count: number; percentage: number }>;
}

export interface OptimizationRecommendation {
  type: "concurrency" | "budget" | "verification" | "planning";
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  suggestedAction: string;
  expectedImpact: string;
  configChanges?: Record<string, unknown>;
}

export class RunAnalyzer {
  private readonly runsRoot: string;

  constructor(runsRoot: string) {
    this.runsRoot = runsRoot;
  }

  async loadRunHistory(limit = 50): Promise<RunSummary[]> {
    if (!(await pathExists(this.runsRoot))) return [];
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    const runIds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);

    const summaries: RunSummary[] = [];
    for (const runId of runIds) {
      try {
        const raw = await readFile(join(this.runsRoot, runId, "state.json"), "utf8");
        const run = JSON.parse(raw) as SwarmRun;
        summaries.push(summarizeRun(run));
      } catch {
        // skip corrupt runs
      }
    }
    return summaries;
  }

  async analyzeTrends(summaries: RunSummary[]): Promise<TrendAnalysis> {
    if (!summaries.length) {
      return {
        totalRuns: 0,
        dateRange: { from: 0, to: 0 },
        overallSuccessRate: 0,
        successRateTrend: "stable",
        avgCostPerRun: 0,
        totalCost: 0,
        costTrend: [],
        avgDurationMs: 0,
        durationTrend: "stable",
        avgConflictRate: 0,
        avgRetryRate: 0,
        commonFailures: [],
      };
    }

    const successful = summaries.filter((summary) => isSuccessfulOutcome(summary));
    const totalRuns = summaries.length;
    const overallSuccessRate = successful.length / totalRuns;
    const recent = summaries.slice(0, Math.min(10, totalRuns));
    const older = summaries.slice(-Math.min(10, totalRuns));
    const recentSuccess = recent.filter(isSuccessfulOutcome).length / recent.length;
    const olderSuccess = older.filter(isSuccessfulOutcome).length / older.length;
    const successRateTrend =
      recentSuccess > olderSuccess + 0.1 ? "improving" :
      recentSuccess < olderSuccess - 0.1 ? "declining" : "stable";

    const totalCost = summaries.reduce((sum, summary) => sum + summary.costUsd, 0);
    const avgDurationMs = summaries.reduce((sum, summary) => sum + summary.durationMs, 0) / totalRuns;
    const recentAvgDuration = recent.reduce((sum, summary) => sum + summary.durationMs, 0) / recent.length;
    const olderAvgDuration = older.reduce((sum, summary) => sum + summary.durationMs, 0) / older.length;
    const durationTrend =
      recentAvgDuration < olderAvgDuration * 0.9 ? "faster" :
      recentAvgDuration > olderAvgDuration * 1.1 ? "slower" : "stable";

    const failureCounts = new Map<string, number>();
    for (const summary of summaries) {
      if (isSuccessfulOutcome(summary)) continue;
      const key = summary.outcome || summary.phase || "unknown";
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    }
    const failureTotal = [...failureCounts.values()].reduce((a, b) => a + b, 0) || 1;

    return {
      totalRuns,
      dateRange: {
        from: Math.min(...summaries.map((summary) => summary.timestamp)),
        to: Math.max(...summaries.map((summary) => summary.timestamp)),
      },
      overallSuccessRate,
      successRateTrend,
      avgCostPerRun: totalCost / totalRuns,
      totalCost,
      costTrend: groupCostByDate(summaries),
      avgDurationMs,
      durationTrend,
      avgConflictRate: summaries.reduce((sum, summary) => sum + summary.conflictRate, 0) / totalRuns,
      avgRetryRate: summaries.reduce((sum, summary) => sum + summary.avgRetries, 0) / totalRuns,
      commonFailures: [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([pattern, count]) => ({ pattern, count, percentage: count / failureTotal })),
    };
  }

  async getRecommendations(trends: TrendAnalysis): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];

    if (trends.avgConflictRate > 0.3) {
      recommendations.push({
        type: "concurrency",
        severity: "high",
        title: "High merge conflict rate",
        description: `Average conflict rate ${(trends.avgConflictRate * 100).toFixed(1)}% exceeds the 30% guideline.`,
        suggestedAction: "Lower worker.maxConcurrency or tighten ownedPaths in plans.",
        expectedImpact: "Fewer merge conflicts and less arbiter spend.",
        configChanges: { worker: { maxConcurrency: 2 } },
      });
    }

    if (trends.avgCostPerRun > 5) {
      recommendations.push({
        type: "budget",
        severity: "medium",
        title: "High average run cost",
        description: `Average cost $${trends.avgCostPerRun.toFixed(2)} per run.`,
        suggestedAction: "Reduce bestOfN, perAgentBudgetUsd, or planner.repoMapTokens for routine tasks.",
        expectedImpact: "Lower spend with modest quality trade-offs.",
        configChanges: { worker: { bestOfN: 1, perAgentBudgetUsd: 1.5 } },
      });
    }

    if (trends.avgRetryRate > 1.5) {
      recommendations.push({
        type: "verification",
        severity: "medium",
        title: "Workers retry often",
        description: `Average retries per worker ${trends.avgRetryRate.toFixed(2)}.`,
        suggestedAction: "Tighten task.acceptance.commands, or set run.verify.full to an explicit test command.",
        expectedImpact: "Fewer fix loops and faster merges.",
      });
    }

    if (trends.overallSuccessRate < 0.6 && trends.totalRuns >= 3) {
      recommendations.push({
        type: "planning",
        severity: "high",
        title: "Low success rate",
        description: `Only ${(trends.overallSuccessRate * 100).toFixed(0)}% of recent runs succeed.`,
        suggestedAction: "Use /swarm config wizard for a high-quality preset, or raise planner budget for better decompositions.",
        expectedImpact: "More one-pass plans and fewer aborted runs.",
        configChanges: { planner: { budgetUsd: 2, maxSubtasks: 6 }, worker: { bestOfN: 2, bestOfNJudge: true } },
      });
    }

    if (trends.durationTrend === "slower" && trends.avgDurationMs > 600_000) {
      recommendations.push({
        type: "concurrency",
        severity: "low",
        title: "Runs are getting slower",
        description: `Average duration ${(trends.avgDurationMs / 60_000).toFixed(1)} minutes and trending slower.`,
        suggestedAction: "Raise concurrency carefully if conflict rate is low, or simplify verification.",
        expectedImpact: "Shorter wall-clock for independent tasks.",
      });
    }

    return recommendations;
  }

  formatReport(summaries: RunSummary[], trends: TrendAnalysis, recommendations: OptimizationRecommendation[]): string {
    const lines = [
      "# Swarm Analyze",
      "",
      `Runs analyzed: ${trends.totalRuns}`,
      `Success rate: ${(trends.overallSuccessRate * 100).toFixed(1)}% (${trends.successRateTrend})`,
      `Avg cost: $${trends.avgCostPerRun.toFixed(2)} (total $${trends.totalCost.toFixed(2)})`,
      `Avg duration: ${(trends.avgDurationMs / 60_000).toFixed(1)} min (${trends.durationTrend})`,
      `Avg conflict rate: ${(trends.avgConflictRate * 100).toFixed(1)}%`,
      `Avg retries: ${trends.avgRetryRate.toFixed(2)}`,
      "",
    ];

    if (trends.commonFailures.length) {
      lines.push("## Common failure outcomes");
      for (const failure of trends.commonFailures) {
        lines.push(`- ${failure.pattern}: ${failure.count} (${(failure.percentage * 100).toFixed(0)}%)`);
      }
      lines.push("");
    }

    if (recommendations.length) {
      lines.push("## Recommendations");
      for (const rec of recommendations) {
        lines.push(`### [${rec.severity}] ${rec.title}`);
        lines.push(rec.description);
        lines.push(`Action: ${rec.suggestedAction}`);
        lines.push(`Impact: ${rec.expectedImpact}`);
        if (rec.configChanges) {
          lines.push("```json");
          lines.push(JSON.stringify(rec.configChanges, null, 2));
          lines.push("```");
        }
        lines.push("");
      }
    } else {
      lines.push("No strong optimization recommendations from recent history.");
      lines.push("");
    }

    if (summaries.length) {
      lines.push("## Recent runs");
      for (const summary of summaries.slice(0, 10)) {
        lines.push(
          `- ${summary.runId} · ${summary.outcome || summary.phase} · $${summary.costUsd.toFixed(2)} · ` +
          `${(summary.durationMs / 60_000).toFixed(1)}m · success ${(summary.successRate * 100).toFixed(0)}% · ${summary.task.slice(0, 60)}`,
        );
      }
    }

    return lines.join("\n");
  }
}

function summarizeRun(run: SwarmRun): RunSummary {
  const workers = Object.values(run.workers ?? {}) as WorkerRuntime[];
  const done = workers.filter((worker) => worker.status === "done").length;
  const durationMs = Math.max(0, (run.updatedAt || run.createdAt) - run.createdAt);
  const retries = workers.reduce((sum, worker) => sum + (worker.retries || 0), 0);
  return {
    runId: run.runId,
    timestamp: run.createdAt,
    phase: run.phase,
    outcome: run.outcome,
    durationMs,
    costUsd: run.totals?.cost ?? 0,
    subtaskCount: workers.length || run.plan?.subtasks.length || 0,
    successRate: workers.length ? done / workers.length : (isSuccessfulOutcome({ outcome: run.outcome, phase: run.phase } as RunSummary) ? 1 : 0),
    conflictRate: run.merged.length ? (run.conflicts?.length || 0) / run.merged.length : 0,
    avgRetries: workers.length ? retries / workers.length : 0,
    task: run.task || "",
  };
}

function isSuccessfulOutcome(summary: Pick<RunSummary, "outcome" | "phase">): boolean {
  if (summary.outcome) return ["applied", "branch", "committed", "planned"].includes(summary.outcome);
  return summary.phase === "done";
}

function groupCostByDate(summaries: RunSummary[]): Array<{ date: string; cost: number }> {
  const groups = new Map<string, number>();
  for (const summary of summaries) {
    const date = new Date(summary.timestamp).toISOString().slice(0, 10);
    groups.set(date, (groups.get(date) ?? 0) + summary.costUsd);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, cost]) => ({ date, cost }));
}
