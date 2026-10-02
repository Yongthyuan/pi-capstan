/**
 * Load configured plugins for a capstan run.
 */

import { DefaultPluginRegistry } from "./plugins/registry.ts";
import type { CapstanConfig } from "./types.ts";
import { expandHomePath } from "./utils.ts";

export async function loadConfiguredPlugins(
  config: CapstanConfig,
  init: Record<string, unknown> = {},
): Promise<DefaultPluginRegistry> {
  const registry = new DefaultPluginRegistry();
  const run = config.run;

  if (run.verificationStrategy) {
    const path = expandHomePath(run.verificationStrategy);
    await registry.register("verification", "configured", path, init);
  }

  if (run.schedulingStrategy) {
    const path = expandHomePath(run.schedulingStrategy);
    await registry.register("scheduling", "configured", path, init);
  }

  for (const [index, modulePath] of (run.collaborationPrimitives ?? []).entries()) {
    if (!modulePath) continue;
    await registry.register("collaboration", `configured-${index}`, expandHomePath(modulePath), init);
  }

  return registry;
}
