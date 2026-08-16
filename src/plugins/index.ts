/**
 * Pi-Swarm Plugin System Exports
 *
 * These types are exported for plugin authors to implement custom strategies.
 */

export type {
  VerificationStrategy,
  SchedulingStrategy,
  CollaborationPrimitive,
  PluginRegistry,
} from './plugins/interfaces.js';

export { DefaultPluginRegistry } from './plugins/registry.js';

// Re-export relevant types for plugin implementation
export type {
  Subtask,
  SwarmPlan,
  VerificationResult,
} from './types.js';
