/**
 * Plugin interfaces for extending pi-capstan behavior.
 *
 * These interfaces allow Claude to create custom strategies for:
 * - Verification (how to validate worker output)
 * - Scheduling (how to order and parallelize tasks)
 * - Collaboration (how workers communicate)
 */

import type { Subtask, CapstanPlan } from "../types.ts";

/**
 * Verification Strategy Plugin
 *
 * Controls how worker output is validated before merging.
 *
 * Example use cases:
 * - Incremental testing (only run affected tests)
 * - Cached validation (skip if output hash matches)
 * - Smart retry (classify failures and decide retry strategy)
 *
 * Runtime contract: plugins may narrow commands via `selectCommands` and
 * advise retries via `classifyFailure`. Selected commands always execute
 * through `verifyCommands` (syntax gate + prefix allowlist).
 */
export interface VerificationStrategy {
  readonly name: string;
  readonly description: string;
  readonly version: string;

  initialize?(config: Record<string, unknown>): Promise<void>;

  /**
   * Select which verification commands to run for this task.
   *
   * @returns Array of commands to execute, or null to use default commands
   */
  selectCommands?(
    task: Subtask,
    worktreePath: string,
    changes: { modified: string[]; added: string[]; deleted: string[] }
  ): Promise<string[] | null>;

  /**
   * Classify a verification failure to decide retry strategy.
   */
  classifyFailure?(
    task: Subtask,
    error: { exitCode: number; stdout: string; stderr: string },
    attemptNumber: number
  ): Promise<{
    category: 'flaky' | 'environment' | 'timeout' | 'real-bug';
    shouldRetry: boolean;
    retryWithModifications?: {
      simplifyGoal?: string;
      reduceScope?: string[];
      additionalContext?: string;
    };
  }>;

  cleanup?(): Promise<void>;
}

/**
 * Scheduling Strategy Plugin
 *
 * Controls how tasks are ordered and parallelized.
 */
export interface SchedulingStrategy {
  readonly name: string;
  readonly description: string;
  readonly version: string;

  initialize?(config: Record<string, unknown>): Promise<void>;

  /**
   * Decide the initial execution order and parallelism.
   * `batches` is advisory width; DAG order stays `dependsOn`.
   */
  schedule(
    plan: CapstanPlan,
    context: {
      maxConcurrency: number;
      remainingBudget: number;
      completedTasks: string[];
    }
  ): Promise<{
    batches: string[][];
    reasoning?: string;
  }>;

  /**
   * Adjust scheduling dynamically based on runtime metrics.
   * Wired when MetricsCollector snapshots are available (M0b).
   */
  adjust?(metrics: {
    avgTaskDuration: number;
    conflictRate: number;
    budgetUtilization: number;
    stalledWorkers: string[];
  }): Promise<{
    newConcurrency?: number;
    deprioritizeTasks?: string[];
    reasoning?: string;
  }>;

  cleanup?(): Promise<void>;
}

/**
 * Collaboration Primitive Plugin
 *
 * Coordination hooks for workers. Custom tools are **not** injected —
 * workers use built-in `capstan_send` / `capstan_inbox`. Plugins may
 * observe or transform coordination via `coordinate`.
 */
export interface CollaborationPrimitive {
  readonly name: string;
  readonly description: string;
  readonly version: string;

  initialize?(config: Record<string, unknown>): Promise<void>;

  /**
   * Handle cross-worker coordination requests (mailbox / future hooks).
   */
  coordinate?(request: {
    from: string;
    to?: string;
    type: string;
    payload: unknown;
  }): Promise<unknown>;

  cleanup?(): Promise<void>;
}

/**
 * Plugin Registry
 */
export interface PluginRegistry {
  register(
    type: 'verification' | 'scheduling' | 'collaboration',
    name: string,
    modulePath: string,
    init?: Record<string, unknown>
  ): Promise<void>;

  get<T>(type: 'verification', name: string): VerificationStrategy | undefined;
  get<T>(type: 'scheduling', name: string): SchedulingStrategy | undefined;
  get<T>(type: 'collaboration', name: string): CollaborationPrimitive | undefined;

  list(type: 'verification' | 'scheduling' | 'collaboration'): Array<{
    name: string;
    description: string;
    version: string;
  }>;

  unregister(type: 'verification' | 'scheduling' | 'collaboration', name: string): Promise<void>;
  cleanup(): Promise<void>;
}
