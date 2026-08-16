/**
 * Load configured plugins for a swarm run.
 */

import { homedir } from "node:os";
import { DefaultPluginRegistry } from "./plugins/registry.ts";
import type { SwarmConfig } from "./types.ts";

function expandPath(input: string): string {
  if (input.startsWith("~/")) return `${homedir()}/${input.slice(2)}`;
  return input;
}

export async function loadConfiguredPlugins(config: SwarmConfig): Promise<DefaultPluginRegistry> {
  const registry = new DefaultPluginRegistry();
  const run = config.run;

  if (run.verificationStrategy) {
    const path = expandPath(run.verificationStrategy);
    await registry.register("verification", "configured", path);
  }

  if (run.schedulingStrategy) {
    const path = expandPath(run.schedulingStrategy);
    await registry.register("scheduling", "configured", path);
  }

  for (const [index, modulePath] of (run.collaborationPrimitives ?? []).entries()) {
    if (!modulePath) continue;
    await registry.register("collaboration", `configured-${index}`, expandPath(modulePath));
  }

  return registry;
}
