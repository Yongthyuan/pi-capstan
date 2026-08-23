import type { GateResult, CapstanConfig } from "./types.ts";

export interface GateModel {
  classify(task: string, repoSummary: string, ruleHits: string[]): Promise<{ complexity: number; parallelizable: boolean; reason: string; estSubtasks: number }>;
}

export function ruleGate(task: string, fileCount: number): { score: number; hits: string[] } {
  let score = 0;
  const hits: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    hits.push(`${points > 0 ? "+" : ""}${points} ${reason}`);
  };
  if (task.length > 200 || /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/m.test(task)) add(2, "长任务/列表");
  const conjunctions = task.match(/和|以及|然后|同时|顺便|\band\b|\bthen\b|\balso\b/gi)?.length ?? 0;
  if (conjunctions >= 2) add(2, "多个并列工作流");
  if (/重构|迁移|全部|所有模块|across|migrate|rewrite|end[- ]to[- ]end/i.test(task)) add(2, "跨模块关键词");
  const paths = new Set(task.match(/[\w.-]+\/[\w./*-]+|[\w.-]+\.(?:ts|tsx|js|py|go|rs|md|json)/g) ?? []);
  if (paths.size >= 3) add(2, "涉及至少三个路径");
  if (/(代码|implement|feature)/i.test(task) && /(测试|test)/i.test(task) && /(文档|docs?|readme)/i.test(task)) add(1, "代码+测试+文档");
  if (/改一行|错别字|typo|解释|看一下|单个文件|one[- ]line/i.test(task)) add(-3, "明确单点动作");
  if (fileCount > 0 && fileCount < 30) add(-2, "小仓库");
  return { score, hits };
}

export async function decideGate(
  task: string,
  fileCount: number,
  repoSummary: string,
  config: CapstanConfig["gate"],
  model?: GateModel,
): Promise<GateResult> {
  const rules = ruleGate(task, fileCount);
  if (rules.score >= config.ruleThresholdHigh) {
    return { decision: "complex", score: rules.score, reason: "规则层判定存在多个工作流", ruleHits: rules.hits, modelUsed: false, estimatedSubtasks: 3 };
  }
  if (rules.score <= config.ruleThresholdLow || !model) {
    return { decision: "simple", score: rules.score, reason: model ? "规则层判定为单点任务" : "未配置门控模型，规则层判定为简单任务", ruleHits: rules.hits, modelUsed: false, estimatedSubtasks: 1 };
  }
  let result: Awaited<ReturnType<GateModel["classify"]>>;
  try {
    result = await model.classify(task, repoSummary, rules.hits);
  } catch (error) {
    return { decision: "simple", score: rules.score, reason: `门控模型失败，安全回退主会话: ${error instanceof Error ? error.message : String(error)}`, ruleHits: rules.hits, modelUsed: false, estimatedSubtasks: 1 };
  }
  if (!Number.isFinite(result.complexity) || typeof result.parallelizable !== "boolean" || typeof result.reason !== "string" || !Number.isFinite(result.estSubtasks)) {
    return { decision: "simple", score: rules.score, reason: "门控模型返回结构无效，安全回退主会话", ruleHits: rules.hits, modelUsed: false, estimatedSubtasks: 1 };
  }
  const score = Math.min(10, Math.max(0, result.complexity));
  const complex = score >= 6 && result.parallelizable;
  return {
    decision: complex ? "complex" : "simple",
    score,
    reason: result.reason,
    ruleHits: rules.hits,
    modelUsed: true,
    estimatedSubtasks: Math.min(12, Math.max(1, Math.trunc(result.estSubtasks))),
  };
}
