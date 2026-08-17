/**
 * Plugin Registry Implementation
 *
 * Manages loading, initialization, and lifecycle of all plugins.
 */

import { pathToFileURL } from 'node:url';
import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  PluginRegistry,
  VerificationStrategy,
  SchedulingStrategy,
  CollaborationPrimitive,
} from './interfaces.ts';

type Plugin = VerificationStrategy | SchedulingStrategy | CollaborationPrimitive;

interface RegisteredPlugin {
  instance: Plugin;
  modulePath: string;
}

export class DefaultPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, Map<string, RegisteredPlugin>>();

  constructor() {
    this.plugins.set('verification', new Map());
    this.plugins.set('scheduling', new Map());
    this.plugins.set('collaboration', new Map());
  }

  async register(
    type: 'verification' | 'scheduling' | 'collaboration',
    name: string,
    modulePath: string,
    init: Record<string, unknown> = {},
  ): Promise<void> {
    // Resolve and validate path
    const absolutePath = resolve(modulePath);
    try {
      await access(absolutePath, constants.R_OK);
    } catch (error) {
      throw new Error(`Plugin module not found or not readable: ${absolutePath}`);
    }

    // Load module
    const moduleUrl = pathToFileURL(absolutePath).href;
    let module: unknown;
    try {
      module = await import(moduleUrl);
    } catch (error) {
      throw new Error(
        `Failed to load plugin module ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Extract default export
    const pluginClass = (module as { default?: unknown }).default;
    if (!pluginClass) {
      throw new Error(`Plugin module ${absolutePath} must have a default export`);
    }

    // Instantiate plugin
    let instance: Plugin;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance = typeof pluginClass === 'function' ? new (pluginClass as any)() : (pluginClass as Plugin);
    } catch (error) {
      throw new Error(
        `Failed to instantiate plugin from ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validate interface
    if (!instance.name || !instance.description || !instance.version) {
      throw new Error(`Plugin from ${absolutePath} must have name, description, and version properties`);
    }

    // Type-specific validation
    if (type === 'verification') {
      const vStrategy = instance as VerificationStrategy;
      if (typeof vStrategy.selectCommands !== 'function' && typeof vStrategy.classifyFailure !== 'function' && typeof vStrategy.verify !== 'function') {
        throw new Error(`Verification plugin must implement selectCommands(), classifyFailure(), or verify()`);
      }
    } else if (type === 'scheduling') {
      const sStrategy = instance as SchedulingStrategy;
      if (typeof sStrategy.schedule !== 'function') {
        throw new Error(`Scheduling plugin must implement schedule() method`);
      }
    } else if (type === 'collaboration') {
      const cPrimitive = instance as CollaborationPrimitive;
      if (typeof cPrimitive.getTools !== 'function') {
        throw new Error(`Collaboration plugin must implement getTools() method`);
      }
    }

    // Initialize if provided
    if (instance.initialize) {
      await instance.initialize(init);
    }

    // Register
    const typeMap = this.plugins.get(type)!;
    if (typeMap.has(name)) {
      throw new Error(`Plugin ${name} is already registered for type ${type}`);
    }

    typeMap.set(name, { instance, modulePath: absolutePath });
  }

  get<T>(type: 'verification', name: string): VerificationStrategy | undefined;
  get<T>(type: 'scheduling', name: string): SchedulingStrategy | undefined;
  get<T>(type: 'collaboration', name: string): CollaborationPrimitive | undefined;
  get<T>(
    type: 'verification' | 'scheduling' | 'collaboration',
    name: string
  ): VerificationStrategy | SchedulingStrategy | CollaborationPrimitive | undefined {
    const typeMap = this.plugins.get(type);
    return typeMap?.get(name)?.instance;
  }

  list(type: 'verification' | 'scheduling' | 'collaboration'): Array<{
    name: string;
    description: string;
    version: string;
  }> {
    const typeMap = this.plugins.get(type);
    if (!typeMap) return [];

    return Array.from(typeMap.values()).map(({ instance }) => ({
      name: instance.name,
      description: instance.description,
      version: instance.version,
    }));
  }

  async unregister(type: 'verification' | 'scheduling' | 'collaboration', name: string): Promise<void> {
    const typeMap = this.plugins.get(type);
    const plugin = typeMap?.get(name);
    if (!plugin) return;

    // Cleanup if provided
    if (plugin.instance.cleanup) {
      await plugin.instance.cleanup();
    }

    typeMap!.delete(name);
  }

  async cleanup(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];

    for (const typeMap of this.plugins.values()) {
      for (const { instance } of typeMap.values()) {
        if (instance.cleanup) {
          cleanupPromises.push(instance.cleanup());
        }
      }
      typeMap.clear();
    }

    await Promise.all(cleanupPromises);
  }
}
