import test from "node:test";
import assert from "node:assert/strict";
import { resolvePiModel, resolvePiModelSpec } from "../src/model-policy.ts";
import { JsonResponseError, PiLlmClient, type ModelContextLike, type PiModelLike } from "../src/llm.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const deepseek = { provider: "deepseek", id: "deepseek-v4-flash", maxTokens: 8000 };
const other = { provider: "another-provider", id: "other" };

function context(model: PiModelLike | undefined = deepseek, authenticated: PiModelLike[] = [deepseek, other]): ModelContextLike {
  return {
    model,
    modelRegistry: {
      getAvailable: () => authenticated,
      find: (provider, id) => [deepseek, other].find((item) => item.provider === provider && item.id === id),
      hasConfiguredAuth: (candidate) => authenticated.includes(candidate),
      complete: async () => ({ content: [] }),
    },
  };
}

test("models inherit the Pi session; explicit authenticated overrides remain available", () => {
  const ctx = context();
  assert.equal(DEFAULT_CONFIG.gate.model, null);
  assert.equal(DEFAULT_CONFIG.planner.model, null);
  assert.equal(DEFAULT_CONFIG.worker.model, null);
  assert.equal(resolvePiModel(ctx), deepseek);
  assert.equal(resolvePiModel(ctx, "another-provider/other"), other);
  assert.equal(resolvePiModelSpec(ctx, "deepseek-v4-flash:high"), "deepseek/deepseek-v4-flash:high");
});

test("missing or unauthenticated models fail without switching provider", () => {
  assert.throws(() => resolvePiModel(context(), "missing/model"), /No authenticated Pi model/);
  assert.throws(() => resolvePiModel(context(deepseek, [other])), /No authenticated Pi model/);
  assert.throws(() => resolvePiModel(context(deepseek, [other]), "deepseek/deepseek-v4-flash"), /No authenticated Pi model/);
  const ctx = context();
  ctx.model = undefined;
  assert.throws(() => resolvePiModel(ctx), /for this session/);
});

test("ambiguous short model names require an explicit provider", () => {
  const ctx = context();
  ctx.modelRegistry.getAvailable = () => [deepseek, { ...deepseek, provider: "proxy" }];
  assert.throws(() => resolvePiModel(ctx, deepseek.id), /Ambiguous/);
});

test("planner uses Pi completion and advertises only the configured worker model", async () => {
  const ctx = context();
  let calledModel: PiModelLike | undefined;
  let outputLimit: number | undefined;
  ctx.modelRegistry.complete = async (model, _context, options: any) => {
    calledModel = model;
    outputLimit = options.maxTokens;
    return { content: [{ type: "text", text: '{"recommend":"solo","reason":"small"}' }] };
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.worker.model = "another-provider/other";
  const client = new PiLlmClient(ctx, config);
  assert.deepEqual(client.workerModels(), [other]);
  await client.plan("small task");
  assert.equal(calledModel, deepseek);
  assert.equal(outputLimit, deepseek.maxTokens);
});

test("planner aborts a streaming request at its deadline and accounts returned usage", async () => {
  const ctx = context();
  const config = structuredClone(DEFAULT_CONFIG);
  config.planner.timeoutSec = 0.02;
  let accounted = 0;
  ctx.modelRegistry.complete = async (_model, _context, options: any) => {
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { content: [], stopReason: "aborted", usage: { input: 3, output: 2, cost: { total: 0.01 } } };
  };
  const client = new PiLlmClient(ctx, config, (usage) => { accounted += usage.input + usage.output; });
  await assert.rejects(client.plan("task"), /Planner timeout/);
  assert.equal(accounted, 5);
});

test("output exhaustion is accounted and cannot enter the JSON repair loop", async () => {
  const ctx = context();
  let accounted = 0;
  ctx.modelRegistry.complete = async () => ({
    content: [{ type: "text", text: '{"recommend":"solo","reason":"truncated result"}' }],
    stopReason: "length", usage: { input: 4, output: 8, cost: { total: 0.02 } },
  });
  const client = new PiLlmClient(ctx, structuredClone(DEFAULT_CONFIG), (usage) => { accounted += usage.input + usage.output; });
  await assert.rejects(client.plan("task"), (error: Error) => {
    assert.match(error.message, /output token limit/);
    assert.equal(error instanceof JsonResponseError, false);
    return true;
  });
  assert.equal(accounted, 12);
});
