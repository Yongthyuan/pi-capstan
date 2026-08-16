/**
 * Example: Shared KV Store Collaboration Primitive
 *
 * Provides a shared key-value store for workers to coordinate.
 *
 * Use cases:
 * - Share discovered constants (API endpoints, config values)
 * - Coordinate naming conventions
 * - Track global state (migrations applied, schemas generated)
 * - Implement barrier synchronization
 *
 * Usage in .pi/swarm.json:
 * {
 *   "run": {
 *     "collaborationPrimitives": ["~/.pi/agent/plugins/shared-kv-store.js"]
 *   }
 * }
 *
 * Workers can then use these tools:
 * - swarm_kv_set(key, value, ttl?)
 * - swarm_kv_get(key)
 * - swarm_kv_list(prefix?)
 * - swarm_kv_delete(key)
 * - swarm_kv_watch(key) - wait for key to be set
 */

import type { CollaborationPrimitive } from '../../../src/plugins/interfaces.ts';

interface KVEntry {
  value: unknown;
  setBy: string;
  setAt: number;
  ttl?: number;
}

export default class SharedKVStore implements CollaborationPrimitive {
  readonly name = 'shared-kv-store';
  readonly description = 'Shared key-value store for worker coordination';
  readonly version = '1.0.0';

  private store = new Map<string, KVEntry>();
  private watchers = new Map<string, Array<{ workerId: string; resolve: (value: unknown) => void }>>();
  private cleanupInterval?: NodeJS.Timeout;

  async initialize(config: Record<string, unknown>): Promise<void> {
    // Start TTL cleanup
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 5000);
  }

  getTools() {
    return [
      {
        name: 'swarm_kv_set',
        description: 'Set a key-value pair in the shared store. Optionally set TTL in milliseconds.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            key: {
              type: 'string',
              description: 'The key to set',
            },
            value: {
              description: 'The value to store (can be any JSON-serializable type)',
            },
            ttl: {
              type: 'number',
              description: 'Optional time-to-live in milliseconds',
            },
          },
          required: ['key', 'value'],
        },
        handler: async (input: Record<string, unknown>, workerId: string) => {
          return this.set(
            input.key as string,
            input.value,
            workerId,
            input.ttl as number | undefined
          );
        },
      },
      {
        name: 'swarm_kv_get',
        description: 'Get a value from the shared store',
        inputSchema: {
          type: 'object' as const,
          properties: {
            key: {
              type: 'string',
              description: 'The key to retrieve',
            },
          },
          required: ['key'],
        },
        handler: async (input: Record<string, unknown>, workerId: string) => {
          return this.get(input.key as string);
        },
      },
      {
        name: 'swarm_kv_list',
        description: 'List all keys, optionally filtered by prefix',
        inputSchema: {
          type: 'object' as const,
          properties: {
            prefix: {
              type: 'string',
              description: 'Optional prefix to filter keys',
            },
          },
        },
        handler: async (input: Record<string, unknown>, workerId: string) => {
          return this.list(input.prefix as string | undefined);
        },
      },
      {
        name: 'swarm_kv_delete',
        description: 'Delete a key from the shared store',
        inputSchema: {
          type: 'object' as const,
          properties: {
            key: {
              type: 'string',
              description: 'The key to delete',
            },
          },
          required: ['key'],
        },
        handler: async (input: Record<string, unknown>, workerId: string) => {
          return this.delete(input.key as string);
        },
      },
      {
        name: 'swarm_kv_watch',
        description: 'Wait for a key to be set. Returns immediately if already set, otherwise blocks until set.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            key: {
              type: 'string',
              description: 'The key to watch',
            },
            timeout: {
              type: 'number',
              description: 'Optional timeout in milliseconds (default: 300000)',
            },
          },
          required: ['key'],
        },
        handler: async (input: Record<string, unknown>, workerId: string) => {
          return this.watch(
            input.key as string,
            workerId,
            (input.timeout as number) || 300000
          );
        },
      },
    ];
  }

  private set(key: string, value: unknown, workerId: string, ttl?: number): { ok: boolean } {
    const entry: KVEntry = {
      value,
      setBy: workerId,
      setAt: Date.now(),
      ttl,
    };

    this.store.set(key, entry);

    // Notify watchers
    const keyWatchers = this.watchers.get(key);
    if (keyWatchers) {
      for (const watcher of keyWatchers) {
        watcher.resolve(value);
      }
      this.watchers.delete(key);
    }

    return { ok: true };
  }

  private get(key: string): { found: boolean; value?: unknown; setBy?: string; age?: number } {
    const entry = this.store.get(key);
    if (!entry) {
      return { found: false };
    }

    // Check TTL
    if (entry.ttl && Date.now() - entry.setAt > entry.ttl) {
      this.store.delete(key);
      return { found: false };
    }

    return {
      found: true,
      value: entry.value,
      setBy: entry.setBy,
      age: Date.now() - entry.setAt,
    };
  }

  private list(prefix?: string): { keys: Array<{ key: string; setBy: string; age: number }> } {
    const keys: Array<{ key: string; setBy: string; age: number }> = [];

    for (const [key, entry] of this.store.entries()) {
      // Check TTL
      if (entry.ttl && Date.now() - entry.setAt > entry.ttl) {
        this.store.delete(key);
        continue;
      }

      // Filter by prefix
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }

      keys.push({
        key,
        setBy: entry.setBy,
        age: Date.now() - entry.setAt,
      });
    }

    return { keys };
  }

  private delete(key: string): { ok: boolean; existed: boolean } {
    const existed = this.store.has(key);
    this.store.delete(key);
    return { ok: true, existed };
  }

  private async watch(key: string, workerId: string, timeout: number): Promise<{ value?: unknown; timedOut: boolean }> {
    // Check if key already exists
    const existing = this.get(key);
    if (existing.found) {
      return { value: existing.value, timedOut: false };
    }

    // Wait for key to be set
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        // Remove from watchers
        const keyWatchers = this.watchers.get(key);
        if (keyWatchers) {
          const index = keyWatchers.findIndex((w) => w.workerId === workerId);
          if (index !== -1) {
            keyWatchers.splice(index, 1);
          }
        }
        resolve({ timedOut: true });
      }, timeout);

      const watcher = {
        workerId,
        resolve: (value: unknown) => {
          clearTimeout(timeoutHandle);
          resolve({ value, timedOut: false });
        },
      };

      const keyWatchers = this.watchers.get(key) || [];
      keyWatchers.push(watcher);
      this.watchers.set(key, keyWatchers);
    });
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.ttl && now - entry.setAt > entry.ttl) {
        this.store.delete(key);
      }
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
    this.watchers.clear();
  }
}
