/**
 * Example: Adaptive Scheduling Strategy
 *
 * Dynamically adjusts concurrency and task ordering based on runtime metrics.
 *
 * Features:
 * - Reduces concurrency when conflict rate is high
 * - Prioritizes critical path tasks
 * - Detects and avoids bottleneck workers
 * - Cost-aware scheduling (expensive tasks first to fail fast)
 *
 * Usage in .pi/swarm.json:
 * {
 *   "run": {
 *     "schedulingStrategy": "~/.pi/agent/plugins/adaptive-scheduler.js"
 *   }
 * }
 */

import type { SchedulingStrategy } from '../../../src/plugins/interfaces.ts';
import type { SwarmPlan, Subtask } from '../../../src/types.ts';

export default class AdaptiveScheduler implements SchedulingStrategy {
  readonly name = 'adaptive-scheduler';
  readonly description = 'Dynamically adjusts concurrency based on conflict rate and performance';
  readonly version = '1.0.0';

  private initialConcurrency: number = 4;
  private minConcurrency: number = 1;
  private maxConcurrency: number = 8;
  private conflictThreshold: number = 0.3; // Reduce concurrency if >30% conflicts
  private criticalPathWeight: number = 2.0;

  async initialize(config: Record<string, unknown>): Promise<void> {
    if (typeof config.initialConcurrency === 'number') {
      this.initialConcurrency = config.initialConcurrency;
    }
    if (typeof config.minConcurrency === 'number') {
      this.minConcurrency = config.minConcurrency;
    }
    if (typeof config.maxConcurrency === 'number') {
      this.maxConcurrency = config.maxConcurrency;
    }
    if (typeof config.conflictThreshold === 'number') {
      this.conflictThreshold = config.conflictThreshold;
    }
    if (typeof config.criticalPathWeight === 'number') {
      this.criticalPathWeight = config.criticalPathWeight;
    }
  }

  async schedule(
    plan: SwarmPlan,
    context: {
      maxConcurrency: number;
      remainingBudget: number;
      completedTasks: string[];
    }
  ): Promise<{
    batches: string[][];
    reasoning?: string;
  }> {
    const tasks = plan.subtasks;
    const completed = new Set(context.completedTasks);

    // Build dependency graph
    const deps = new Map<string, Set<string>>();
    const reverseDeps = new Map<string, Set<string>>();

    for (const task of tasks) {
      deps.set(task.id, new Set(task.dependsOn || []));
      reverseDeps.set(task.id, new Set());
    }

    for (const task of tasks) {
      for (const depId of task.dependsOn || []) {
        reverseDeps.get(depId)?.add(task.id);
      }
    }

    // Calculate critical path lengths
    const criticalPath = this.calculateCriticalPath(tasks, deps, reverseDeps);

    // Score each task
    const scores = new Map<string, number>();
    for (const task of tasks) {
      if (completed.has(task.id)) continue;

      let score = 0;

      // Critical path tasks get priority
      score += (criticalPath.get(task.id) || 0) * this.criticalPathWeight;

      // High token estimate = expensive = run early to fail fast
      if (task.estTokens) {
        score += task.estTokens / 10000;
      }

      // Tasks with many dependents get priority (unblock more work)
      score += (reverseDeps.get(task.id)?.size || 0) * 1.5;

      // Tasks with no dependencies get slight boost (can start immediately)
      if ((deps.get(task.id)?.size || 0) === 0) {
        score += 0.5;
      }

      scores.set(task.id, score);
    }

    // Sort by score descending
    const sortedTasks = tasks
      .filter((t) => !completed.has(t.id))
      .sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0));

    // Build batches respecting dependencies and concurrency
    const batches: string[][] = [];
    const scheduled = new Set(completed);

    while (scheduled.size < tasks.length) {
      const batch: string[] = [];

      for (const task of sortedTasks) {
        if (scheduled.has(task.id)) continue;

        // Check if all dependencies are satisfied
        const taskDeps = deps.get(task.id) || new Set();
        const ready = Array.from(taskDeps).every((depId) => scheduled.has(depId));

        if (ready && batch.length < context.maxConcurrency) {
          batch.push(task.id);
          scheduled.add(task.id);
        }
      }

      if (batch.length === 0) break; // No more ready tasks
      batches.push(batch);
    }

    const reasoning = [
      `Scheduled ${batches.length} batches with initial concurrency ${context.maxConcurrency}`,
      `Critical path prioritization enabled (weight: ${this.criticalPathWeight})`,
      `Expensive tasks scheduled first to fail fast`,
    ].join('. ');

    return { batches, reasoning };
  }

  async adjust(metrics: {
    avgTaskDuration: number;
    conflictRate: number;
    budgetUtilization: number;
    stalledWorkers: string[];
  }): Promise<{
    newConcurrency?: number;
    deprioritizeTasks?: string[];
    reasoning?: string;
  }> {
    const adjustments: string[] = [];
    let newConcurrency: number | undefined;
    const deprioritizeTasks: string[] = [];

    // High conflict rate -> reduce concurrency
    if (metrics.conflictRate > this.conflictThreshold) {
      newConcurrency = Math.max(this.minConcurrency, Math.floor(this.initialConcurrency * 0.7));
      adjustments.push(
        `Conflict rate ${(metrics.conflictRate * 100).toFixed(1)}% exceeds threshold, reducing concurrency to ${newConcurrency}`
      );
    }

    // Low conflict rate and fast tasks -> increase concurrency
    if (metrics.conflictRate < 0.1 && metrics.avgTaskDuration < 120000) {
      // < 2 minutes avg
      newConcurrency = Math.min(this.maxConcurrency, this.initialConcurrency + 1);
      adjustments.push(`Low conflict rate and fast tasks, increasing concurrency to ${newConcurrency}`);
    }

    // Budget running low -> reduce concurrency to conserve
    if (metrics.budgetUtilization > 0.8) {
      newConcurrency = Math.max(this.minConcurrency, Math.floor((this.initialConcurrency * 2) / 3));
      adjustments.push(`Budget 80%+ utilized, reducing concurrency to ${newConcurrency} to conserve`);
    }

    // Stalled workers -> deprioritize their tasks in future batches
    if (metrics.stalledWorkers.length > 0) {
      deprioritizeTasks.push(...metrics.stalledWorkers);
      adjustments.push(`Deprioritizing ${metrics.stalledWorkers.length} stalled worker tasks`);
    }

    return {
      newConcurrency,
      deprioritizeTasks: deprioritizeTasks.length > 0 ? deprioritizeTasks : undefined,
      reasoning: adjustments.length > 0 ? adjustments.join('. ') : undefined,
    };
  }

  private calculateCriticalPath(
    tasks: Subtask[],
    deps: Map<string, Set<string>>,
    reverseDeps: Map<string, Set<string>>
  ): Map<string, number> {
    const pathLength = new Map<string, number>();

    // Topological sort
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) return; // Cycle, should not happen with validated DAG

      visiting.add(id);
      for (const depId of deps.get(id) || []) {
        visit(depId);
      }
      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
    };

    for (const task of tasks) {
      visit(task.id);
    }

    // Calculate longest path from each node
    for (const id of sorted) {
      const depLengths = Array.from(deps.get(id) || []).map((depId) => pathLength.get(depId) || 0);
      pathLength.set(id, depLengths.length > 0 ? Math.max(...depLengths) + 1 : 1);
    }

    return pathLength;
  }
}
