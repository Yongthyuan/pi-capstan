import type { GateModel } from "./gate.ts";
import { resolvePiModel } from "./model-policy.ts";
import type { CapstanConfig, CapstanPlan, UsageTotals } from "./types.ts";
import { makeRunId } from "./utils.ts";

export interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
  cost?: Record<string, number>;
  maxTokens?: number;
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

  workerModels(): PiModelLike[] {
    return [resolvePiModel(this.ctx, this.config.worker.model)];
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
    const model = resolvePiModel(this.ctx, modelSpec);
    const maxTokens = Math.min(this.config.planner.tokenLimit, model.maxTokens ?? Infinity);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.planner.timeoutSec * 1_000);
    const timeoutError = () => new Error(`Planner timeout after ${this.config.planner.timeoutSec}s.`);
    let response;
    try {
      response = await this.ctx.modelRegistry.complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        {
          ...(reasoningEffort === "off" ? {} : { reasoningEffort }),
          signal: controller.signal,
          cacheRetention: "none",
          sessionId: makeRunId(),
          timeoutMs: this.config.planner.timeoutSec * 1_000,
          maxTokens,
          maxRetries: 1,
        },
      );
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const usage = normalizeUsage(response.usage);
    await this.onUsage?.(usage, { model: `${model.provider}/${model.id}`, stopReason: response.stopReason });
    if (controller.signal.aborted) throw timeoutError();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `planner model ${response.stopReason}`);
    }
    if (response.stopReason === "length") {
      throw new Error(`Planner output token limit reached (${maxTokens}, including model reasoning). Increase planner.tokenLimit before retrying.`);
    }
    const text = response.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    try {
      return parseJsonFromText<T>(text);
    } catch (error) {
      throw new JsonResponseError(error instanceof Error ? error.message : String(error), text);
    }
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
  const attempts = [candidate, repairCommonJsonIssues(candidate)];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Best-effort fixes for common model JSON slips before giving up on the parse. */
export function repairCommonJsonIssues(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
}
