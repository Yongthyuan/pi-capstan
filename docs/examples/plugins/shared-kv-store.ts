/**
 * Example: Shared KV Store Collaboration Primitive
 *
 * Coordination via `coordinate()` — Capstan does **not** inject custom tools
 * into workers. Workers keep using `capstan_send` / `capstan_inbox`; a host
 * extension can forward structured mailbox messages into `coordinate`.
 *
 * Usage in .pi/capstan.json:
 * {
 *   "run": {
 *     "collaborationPrimitives": ["/absolute/path/to/shared-kv-store.ts"]
 *   }
 * }
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
  readonly description = 'Shared key-value store for worker coordination (coordinate hook only)';
  readonly version = '1.1.0';

  private store = new Map<string, KVEntry>();
  private cleanupInterval?: ReturnType<typeof setInterval>;

  async initialize(_config: Record<string, unknown>): Promise<void> {
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 5000);
  }

  async coordinate(request: {
    from: string;
    to?: string;
    type: string;
    payload: unknown;
  }): Promise<unknown> {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    switch (request.type) {
      case 'kv.set':
        return this.set(String(payload.key), payload.value, request.from, payload.ttl as number | undefined);
      case 'kv.get':
        return this.get(String(payload.key));
      case 'kv.list':
        return this.list(payload.prefix as string | undefined);
      case 'kv.delete':
        return this.delete(String(payload.key));
      default:
        return { ok: false, error: `unknown coordination type: ${request.type}` };
    }
  }

  private set(key: string, value: unknown, workerId: string, ttl?: number): { ok: boolean } {
    this.store.set(key, { value, setBy: workerId, setAt: Date.now(), ttl });
    return { ok: true };
  }

  private get(key: string): { found: boolean; value?: unknown; setBy?: string; age?: number } {
    const entry = this.store.get(key);
    if (!entry) return { found: false };
    if (entry.ttl && Date.now() - entry.setAt > entry.ttl) {
      this.store.delete(key);
      return { found: false };
    }
    return { found: true, value: entry.value, setBy: entry.setBy, age: Date.now() - entry.setAt };
  }

  private list(prefix?: string): { keys: Array<{ key: string; setBy: string; age: number }> } {
    const keys: Array<{ key: string; setBy: string; age: number }> = [];
    for (const [key, entry] of this.store.entries()) {
      if (entry.ttl && Date.now() - entry.setAt > entry.ttl) {
        this.store.delete(key);
        continue;
      }
      if (prefix && !key.startsWith(prefix)) continue;
      keys.push({ key, setBy: entry.setBy, age: Date.now() - entry.setAt });
    }
    return { keys };
  }

  private delete(key: string): { ok: boolean; existed: boolean } {
    const existed = this.store.has(key);
    this.store.delete(key);
    return { ok: true, existed };
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.ttl && now - entry.setAt > entry.ttl) this.store.delete(key);
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}
