import type { GateModel } from "./gate.ts";
import type { CapstanConfig, CapstanPlan, UsageTotals } from "./types.ts";
import { makeRunId } from "./utils.ts";

export interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
  cost?: Record<string, number>;
}

export interface ModelContextLike {
  model?: PiModelLike;
  modelRegistry: {
    getAvailable(): PiModelLike[];
    find(provider: string, id: string): PiModelLike | undefined;
    hasConfiguredAuth(model: PiModelLike): boolean;
    complete(model: PiModelLike, context: unknown, options?: unknown): Promise<{ content: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string; usage?: any }>;
  };
}

export type LlmUsageHook = (usage: UsageTotals, meta: { model: string; stopReason?: string }) => void | Promise<void>;

export class PiLlmClient implements GateModel {
  private readonly ctx: ModelContextLike;
  private readonly config: CapstanConfig;
  private readonly onUsage?: LlmUsageHook;

  constructor(ctx: ModelContextLike, config: CapstanConfig, onUsage?: LlmUsageHook) {
    this.ctx = ctx;
    this.config = config;
    this.onUsage = onUsage;
  }

  availableModels(): PiModelLike[] {
    return this.ctx.modelRegistry.getAvailable().filter((model) => this.ctx.modelRegistry.hasConfiguredAuth(model));
  }

  async classify(task: string, repoSummary: string, ruleHits: string[]) {
    return this.completeJson<{ complexity: number; parallelizable: boolean; reason: string; estSubtasks: number }>(
      this.config.gate.model,
      `You are a task-complexity classifier for a coding agent capstan.\nTask: ${task}\nRepo: ${repoSummary}\nRule signals: ${ruleHits.join(", ")}\nA task is complex only when it contains at least two largely independent workstreams. Respond with JSON only: {"complexity":0,"parallelizable":false,"reason":"one sentence","estSubtasks":1}`,
      "off",
    );
  }

  async plan(prompt: string): Promise<CapstanPlan | { recommend: "solo"; reason: string }> {
    return this.completeJson<CapstanPlan | { recommend: "solo"; reason: string }>(this.config.planner.model, prompt, "high");
  }

  async repairPlan(raw: string, errors: string[], prompt: string): Promise<CapstanPlan | { recommend: "solo"; reason: string }> {
    return this.completeJson<CapstanPlan | { recommend: "solo"; reason: string }>(
      this.config.planner.model,
      `${prompt}\n\nThe previous JSON was invalid:\n${raw}\n\nValidation errors:\n- ${errors.join("\n- ")}\nReturn corrected JSON only.`,
      "high",
    );
  }

  private async completeJson<T>(modelSpec: string | null, prompt: string, reasoningEffort: string): Promise<T> {
    const model = this.resolveModel(modelSpec);
    if (!model)
      throw new Error(
        `No authenticated model available${modelSpec ? ` for ${modelSpec}` : ""}. Fix: open Pi, pick a model with /model and complete provider sign-in, then retry.\n没有可用且已认证的模型——请在 Pi 中用 /model 选择模型并完成认证后重试。`,
      );
    const response = await this.ctx.modelRegistry.complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      {
        reasoningEffort,
        cacheRetention: "none",
        sessionId: makeRunId(),
        timeoutMs: this.config.planner.timeoutSec * 1_000,
        maxTokens: this.config.planner.tokenLimit,
        maxRetries: 1,
      },
    );
    const usage = normalizeUsage(response.usage);
    await this.onUsage?.(usage, { model: `${model.provider}/${model.id}`, stopReason: response.stopReason });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `planner model ${response.stopReason}`);
    }
    const text = response.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    try {
      return parseJsonFromText<T>(text);
    } catch (error) {
      throw new JsonResponseError(error instanceof Error ? error.message : String(error), text);
    }
  }

  private resolveModel(spec: string | null): PiModelLike | undefined {
    if (spec) {
      const slash = spec.indexOf("/");
      if (slash > 0) return this.ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1).replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, ""));
      return this.availableModels().find((model) => model.id === spec || model.name === spec);
    }
    if (this.ctx.model && this.ctx.modelRegistry.hasConfiguredAuth(this.ctx.model)) return this.ctx.model;
    return this.availableModels()[0];
  }
}

function normalizeUsage(usage: any): UsageTotals {
  return {
    input: Number(usage?.input ?? 0),
    output: Number(usage?.output ?? 0),
    cacheRead: Number(usage?.cacheRead ?? 0),
    cacheWrite: Number(usage?.cacheWrite ?? 0),
    cost: Number(usage?.cost?.total ?? usage?.cost ?? 0),
  };
}

export class JsonResponseError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = "JsonResponseError";
    this.raw = raw;
  }
}

export function parseJsonFromText<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("模型没有返回 JSON");
  return JSON.parse(candidate) as T;
}
