/**
 * Plugin interfaces for extending pi-swarm behavior.
 *
 * These interfaces allow Claude to create custom strategies for:
 * - Verification (how to validate worker output)
 * - Scheduling (how to order and parallelize tasks)
 * - Collaboration (how workers communicate)
 */

import type { Subtask, VerificationResult, SwarmPlan } from '../types.js';

/**
 * Verification Strategy Plugin
 *
 * Controls how worker output is validated before merging.
 *
 * Example use cases:
 * - Incremental testing (only run affected tests)
 * - Cached validation (skip if output hash matches)
 * - Smart retry (classify failures and decide retry strategy)
 */
export interface VerificationStrategy {
  /**
   * Plugin metadata
   */
  readonly name: string;
  readonly description: string;
  readonly version: string;

  /**
   * Called once when the plugin is loaded.
   * Use this to validate configuration and initialize resources.
   */
  initialize?(config: Record<string, unknown>): Promise<void>;

  /**
   * Select which verification commands to run for this task.
   *
   * @param task - The completed subtask
   * @param worktreePath - Path to the worker's isolated worktree
   * @param changes - Files modified by this worker
   * @returns Array of commands to execute, or null to use default commands
   */
  selectCommands?(
    task: Subtask,
    worktreePath: string,
    changes: { modified: string[]; added: string[]; deleted: string[] }
  ): Promise<string[] | null>;

  /**
   * Execute verification and return results.
   *
   * @param task - The completed subtask
   * @param worktreePath - Path to the worker's isolated worktree
   * @param commands - Commands to execute (from selectCommands or task.acceptance.commands)
   * @returns Verification result with ok/failed status
   */
  verify(
    task: Subtask,
    worktreePath: string,
    commands: string[]
  ): Promise<VerificationResult>;

  /**
   * Classify a verification failure to decide retry strategy.
   *
   * @param task - The failed subtask
   * @param error - The verification error details
   * @param attemptNumber - Current retry attempt (1-indexed)
   * @returns Classification and retry recommendation
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

  /**
   * Called when plugin is unloaded or swarm completes.
   */
  cleanup?(): Promise<void>;
}

/**
 * Scheduling Strategy Plugin
 *
 * Controls how tasks are ordered and parallelized.
 *
 * Example use cases:
 * - Critical path optimization
 * - Cost-aware scheduling (expensive tasks first/last)
 * - Adaptive concurrency based on conflict rate
 */
export interface SchedulingStrategy {
  readonly name: string;
  readonly description: string;
  readonly version: string;

  initialize?(config: Record<string, unknown>): Promise<void>;

  /**
   * Decide the initial execution order and parallelism.
   *
   * @param plan - The validated swarm plan with DAG
   * @param context - Runtime context (available slots, budget)
   * @returns Ordered batches of task IDs to execute
   */
  schedule(
    plan: SwarmPlan,
    context: {
      maxConcurrency: number;
      remainingBudget: number;
      completedTasks: string[];
    }
  ): Promise<{
    batches: string[][]; // Each batch runs in parallel
    reasoning?: string;
  }>;

  /**
   * Adjust scheduling dynamically based on runtime metrics.
   *
   * @param metrics - Current execution metrics
   * @returns Adjusted concurrency level or task reordering
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
 * Adds custom tools and coordination mechanisms for workers.
 *
 * Example use cases:
 * - Shared key-value store
 * - Request-response protocol
 * - Barrier synchronization
 * - Pub-sub messaging
 */
export interface CollaborationPrimitive {
  readonly name: string;
  readonly description: string;
  readonly version: string;

  initialize?(config: Record<string, unknown>): Promise<void>;

  /**
   * Return custom tools to inject into worker sessions.
   *
   * Each tool will be available as a MCP tool in the worker's Pi session.
   */
  getTools(): Array<{
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
    handler: (input: Record<string, unknown>, workerId: string) => Promise<unknown>;
  }>;

  /**
   * Handle cross-worker coordination requests.
   *
   * Called when a worker uses a collaboration tool.
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
 *
 * Manages loading and lifecycle of all plugins.
 */
export interface PluginRegistry {
  /**
   * Register a plugin from a file path.
   *
   * @param type - Plugin type
   * @param name - Unique plugin name
   * @param modulePath - Path to the plugin module (must export default)
   */
  register(
    type: 'verification' | 'scheduling' | 'collaboration',
    name: string,
    modulePath: string
  ): Promise<void>;

  /**
   * Get a registered plugin.
   */
  get<T>(type: 'verification', name: string): VerificationStrategy | undefined;
  get<T>(type: 'scheduling', name: string): SchedulingStrategy | undefined;
  get<T>(type: 'collaboration', name: string): CollaborationPrimitive | undefined;

  /**
   * List all registered plugins of a type.
   */
  list(type: 'verification' | 'scheduling' | 'collaboration'): Array<{
    name: string;
    description: string;
    version: string;
  }>;

  /**
   * Unregister and cleanup a plugin.
   */
  unregister(type: 'verification' | 'scheduling' | 'collaboration', name: string): Promise<void>;

  /**
   * Cleanup all plugins.
   */
  cleanup(): Promise<void>;
}
