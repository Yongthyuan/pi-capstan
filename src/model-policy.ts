import type { ModelContextLike, PiModelLike } from "./llm.ts";

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Resolve through Pi only. Never fall back to a different provider or model. */
export function resolvePiModel(ctx: ModelContextLike, spec?: string | null): PiModelLike {
  let model: PiModelLike | undefined;
  if (spec) {
    const normalized = spec.replace(THINKING_SUFFIX, "");
    const slash = normalized.indexOf("/");
    if (slash > 0) model = ctx.modelRegistry.find(normalized.slice(0, slash), normalized.slice(slash + 1));
    if (!model) {
      const matches = ctx.modelRegistry.getAvailable().filter((candidate) => candidate.id === normalized || candidate.name === normalized);
      if (matches.length > 1) throw new Error(`Ambiguous Pi model ${spec}; use provider/model.`);
      model = matches[0];
    }
  } else {
    model = ctx.model;
  }
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `No authenticated Pi model available${spec ? ` for ${spec}` : " for this session"}. ` +
      "Select a model with /model and configure its provider with /login in Pi.\n" +
      "请在 Pi 中用 /model 选择模型、用 /login 配置对应认证；Capstan 不单独保存 API 密钥。",
    );
  }
  return model;
}

/** Canonical provider/model for child Pi processes, preserving a thinking suffix. */
export function resolvePiModelSpec(ctx: ModelContextLike, spec?: string | null): string {
  const model = resolvePiModel(ctx, spec);
  return `${model.provider}/${model.id}${spec?.match(THINKING_SUFFIX)?.[0] ?? ""}`;
}
