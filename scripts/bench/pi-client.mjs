import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "../../src/model-policy.ts";

/** Same Pi runtime, models.json, and credential store used by /capstan. */
export async function createPiContext(spec) {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const modelRegistry = new ModelRegistry(runtime);
  if (modelRegistry.getError()) throw new Error(modelRegistry.getError());
  if (!spec) {
    let settings = {};
    try { settings = JSON.parse(await readFile(join(getAgentDir(), "settings.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (settings.defaultProvider && settings.defaultModel) spec = settings.defaultProvider + "/" + settings.defaultModel;
  }
  if (!spec) throw new Error("Select a model in Pi, or pass --model provider/model (PI_CAPSTAN_TEST_MODEL is also supported).");
  const model = resolvePiModel({ modelRegistry }, spec);
  return { model, modelRegistry };
}
