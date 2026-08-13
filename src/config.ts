import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SwarmConfig } from "./types.ts";
import { pathExists } from "./utils.ts";

export const DEFAULT_CONFIG: SwarmConfig = {
  gate: { model: null, ruleThresholdHigh: 5, ruleThresholdLow: 0 },
  planner: {
    model: null,
    maxSubtasks: 6,
    repoMapTokens: 4_500,
    schemaRetries: 2,
    timeoutSec: 120,
    budgetUsd: 1,
    tokenLimit: 160_000,
  },
  worker: {
    model: null,
    maxConcurrency: 4,
    maxRetries: 2,
    stallSec: 180,
    wallClockMin: 25,
    perAgentBudgetUsd: 2,
    perAgentTokenLimit: 250_000,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "swarm_send", "swarm_inbox", "swarm_fs"],
    setupCommands: [],
    setupTimeoutSec: 300,
    shareDependencyDirs: ["node_modules"],
    scopeAllowlist: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "uv.lock"],
    scopeViolationPolicy: "revert",
    strictBash: false,
    bestOfN: 1,
    bestOfNJudge: true,
  },
  run: {
    budgetUsd: 8,
    tokenLimit: 1_000_000,
    mergeStrategy: "branch",
    verify: { worker: null, integrationLight: null, full: null },
    verifyTimeoutSec: 300,
    verifyAllowedPrefixes: [
      "npm test",
      "npm run",
      "npm exec --no --",
      "pnpm test",
      "pnpm run",
      "pnpm exec",
      "yarn test",
      "yarn run",
      "yarn exec",
      "bun test",
      "bun run",
      "python -m pytest",
      "python3 -m pytest",
      "pytest",
      "cargo test",
      "cargo check",
      "cargo build",
      "cargo clippy",
      "go test",
      "go build",
      "go vet",
      "./gradlew test",
      "./gradlew check",
      "./gradlew build",
      "mvn test",
      "mvn verify",
      "dotnet test",
      "dotnet build",
      "./node_modules/.bin/tsc",
    ],
    setupAllowedPrefixes: ["npm ci", "npm install", "pnpm install", "yarn install", "bun install", "python -m pip install", "python3 -m pip install", "uv sync", "cargo fetch"],
    failurePolicy: "continue-independent",
  },
  approvalPolicy: "route",
  bashDenylist: [
    "\\bgit\\b[^\\n]*(?:\\s)(?:add|am|apply|bisect|branch|checkout|cherry-pick|clean|commit|merge|mv|push|rebase|reset|restore|revert|rm|switch|tag|update-index|update-ref|worktree)\\b",
    "\\bsudo\\b",
    "\\brm\\b[^\\n]*\\s-rf\\s+[/~]",
    "\\b(?:curl|wget)\\b[^|\\n]*\\|\\s*(?:sh|bash|zsh)\\b",
    "(?:^|[;&|]\\s*)(?:rm|mv|cp|touch|mkdir|install|ln|truncate|dd|tee)\\b",
    "\\b(?:sed\\s+-[^\\n]*i|perl\\s+-[^\\n]*i)\\b",
    "(?:^|[^<])>{1,2}(?:[^>]|$)",
  ],
  caseStore: { enabled: true, max: 200, threshold: 0.35, matcher: "hybrid" },
  retention: { logsDays: 14, sessionsDays: 30 },
  ui: { renderThrottleMs: 250, reportTriggerTurn: false, approvalBatchMs: 100 },
  safetyGuardPath: null,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const prior = result[key];
    result[key] = isPlainObject(prior) && isPlainObject(value) ? deepMerge(prior, value) : value;
  }
  return result as T;
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  if (!(await pathExists(path))) return undefined;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function loadConfig(agentDir: string, repoRoot: string, configDirName: string): Promise<SwarmConfig> {
  let config = structuredClone(DEFAULT_CONFIG);
  const globalConfig = await readJsonIfPresent(join(agentDir, "swarm.json"));
  if (globalConfig) config = deepMerge(config, globalConfig);
  const projectConfig = await readJsonIfPresent(join(repoRoot, configDirName, "swarm.json"));
  if (projectConfig) config = deepMerge(config, projectConfig);
  return validateConfig(config);
}

export function validateConfig(config: SwarmConfig): SwarmConfig {
  for (const key of ["gate", "planner", "worker", "run", "caseStore", "retention", "ui"] as const) {
    if (!isPlainObject(config[key])) throw new Error(`配置 ${key} 必须是对象`);
  }
  if (!isPlainObject(config.run.verify)) throw new Error("配置 run.verify 必须是对象");
  config.worker.maxConcurrency = clampInt(config.worker.maxConcurrency, 1, 8);
  config.worker.maxRetries = clampInt(config.worker.maxRetries, 0, 5);
  config.planner.maxSubtasks = clampInt(config.planner.maxSubtasks, 2, 12);
  config.planner.schemaRetries = clampInt(config.planner.schemaRetries, 0, 5);
  config.planner.repoMapTokens = clampInt(config.planner.repoMapTokens, 500, 50_000);
  config.planner.timeoutSec = clampInt(config.planner.timeoutSec, 10, 900);
  config.planner.tokenLimit = clampInt(config.planner.tokenLimit, 1_000, 1_000_000);
  config.planner.budgetUsd = positiveNumber(config.planner.budgetUsd, DEFAULT_CONFIG.planner.budgetUsd);
  config.gate.ruleThresholdLow = clampInt(config.gate.ruleThresholdLow, -20, 20);
  config.gate.ruleThresholdHigh = clampInt(config.gate.ruleThresholdHigh, config.gate.ruleThresholdLow + 1, 30);
  config.run.verifyTimeoutSec = clampInt(config.run.verifyTimeoutSec, 10, 3600);
  config.worker.stallSec = clampInt(config.worker.stallSec, 10, 3600);
  config.worker.wallClockMin = clampInt(config.worker.wallClockMin, 1, 240);
  config.worker.setupTimeoutSec = clampInt(config.worker.setupTimeoutSec, 10, 3600);
  config.worker.bestOfN = clampInt(config.worker.bestOfN, 1, 8);
  config.ui.renderThrottleMs = clampInt(config.ui.renderThrottleMs, 25, 5_000);
  config.ui.approvalBatchMs = clampInt(config.ui.approvalBatchMs, 0, 2_000);
  config.retention.logsDays = clampInt(config.retention.logsDays, 1, 3650);
  config.retention.sessionsDays = clampInt(config.retention.sessionsDays, 1, 3650);
  config.worker.perAgentTokenLimit = Math.max(1_000, config.worker.perAgentTokenLimit);
  config.run.tokenLimit = Math.max(config.worker.perAgentTokenLimit, config.run.tokenLimit);
  config.worker.perAgentBudgetUsd = positiveNumber(config.worker.perAgentBudgetUsd, DEFAULT_CONFIG.worker.perAgentBudgetUsd);
  config.run.budgetUsd = positiveNumber(config.run.budgetUsd, DEFAULT_CONFIG.run.budgetUsd);
  if (!Array.isArray(config.worker.tools) || config.worker.tools.length === 0) {
    config.worker.tools = [...DEFAULT_CONFIG.worker.tools];
  }
  if (!Array.isArray(config.worker.setupCommands) || config.worker.setupCommands.some((item) => typeof item !== "string" || !item.trim())) config.worker.setupCommands = [];
  if (!Array.isArray(config.worker.shareDependencyDirs) || config.worker.shareDependencyDirs.some((item) => typeof item !== "string" || !safeRelativePath(item))) config.worker.shareDependencyDirs = [...DEFAULT_CONFIG.worker.shareDependencyDirs];
  if (!Array.isArray(config.worker.scopeAllowlist) || config.worker.scopeAllowlist.some((item) => typeof item !== "string" || !safeRelativePath(item))) config.worker.scopeAllowlist = [...DEFAULT_CONFIG.worker.scopeAllowlist];
  if (!Array.isArray(config.run.setupAllowedPrefixes) || config.run.setupAllowedPrefixes.some((item) => typeof item !== "string" || !item.trim())) config.run.setupAllowedPrefixes = [...DEFAULT_CONFIG.run.setupAllowedPrefixes];
  if (!Array.isArray(config.run.verifyAllowedPrefixes) || config.run.verifyAllowedPrefixes.some((item) => typeof item !== "string" || !item.trim())) {
    config.run.verifyAllowedPrefixes = [...DEFAULT_CONFIG.run.verifyAllowedPrefixes];
  }
  if (!Array.isArray(config.bashDenylist) || config.bashDenylist.some((item) => typeof item !== "string")) {
    config.bashDenylist = [...DEFAULT_CONFIG.bashDenylist];
  }
  for (const expression of config.bashDenylist) {
    try { new RegExp(expression, "i"); } catch { throw new Error(`无效 bashDenylist 正则: ${expression}`); }
  }
  if (!["route", "autoDeny", "autoAllow"].includes(config.approvalPolicy)) throw new Error("approvalPolicy 非法");
  if (!["branch", "apply", "commit"].includes(config.run.mergeStrategy)) throw new Error("run.mergeStrategy 非法");
  if (!["fail", "revert"].includes(config.worker.scopeViolationPolicy)) throw new Error("worker.scopeViolationPolicy 非法");
  config.worker.strictBash = Boolean(config.worker.strictBash);
  if (!["fail-fast", "continue-independent"].includes(config.run.failurePolicy)) throw new Error("run.failurePolicy 非法");
  if (!["lexical", "hybrid"].includes(config.caseStore.matcher)) throw new Error("caseStore.matcher 非法");
  config.caseStore.max = clampInt(config.caseStore.max, 1, 10_000);
  config.caseStore.threshold = Math.min(1, Math.max(0, Number(config.caseStore.threshold) || 0));
  for (const [name, commands] of Object.entries(config.run.verify)) {
    if (commands !== null && (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || !command.trim()))) {
      throw new Error(`run.verify.${name} 必须是字符串数组或 null`);
    }
  }
  return config;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}
