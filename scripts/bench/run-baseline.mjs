import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { PiLlmClient } from "../../src/llm.ts";
import { redactPublicText } from "../../src/reporter.ts";
import { atomicWriteJson, runCommand } from "../../src/utils.ts";
import { classifyFail, computeTotals, qualityPassFor } from "./metrics.ts";
import { buildRepoBrief, createPlan } from "../../src/planner.ts";
import { validatePlan } from "../../src/plan-validation.ts";
import { createPiContext } from "./pi-client.mjs";
import { materializeFixtures } from "./fixtures-materialize.mjs";
import { loadTasks, summarizeCatalog } from "./load-tasks.mjs";

class InstrumentedLlm extends PiLlmClient {
  usage = { input: 0, output: 0, cost: 0 };
  calls = 0;
  responses = [];
  schemaRetriesUsed = 0;
  firstValidationFailed = false;

  constructor(ctx, config, ledger) {
    super(ctx, config, async (usage, meta) => {
      this.responses.push({ ...meta, usage });
      this.usage.input += usage.input;
      this.usage.output += usage.output;
      this.usage.cost += usage.cost;
      ledger.cost += usage.cost;
      if (ledger.cost >= ledger.limit) throw new Error("Benchmark budget reached; stopping further model calls.");
    });
    this.ledger = ledger;
  }

  async plan(prompt) {
    if (this.ledger.cost >= this.ledger.limit) throw new Error("Benchmark budget reached.");
    this.calls += 1;
    return super.plan(prompt);
  }

  async repairPlan(raw, errors, prompt) {
    if (this.ledger.cost >= this.ledger.limit) throw new Error("Benchmark budget reached.");
    this.calls += 1;
    this.schemaRetriesUsed += 1;
    if (this.schemaRetriesUsed === 1) this.firstValidationFailed = true;
    return super.repairPlan(raw, errors, prompt);
  }
}

function scoreGolden(golden, plan) {
  if (!golden || !plan?.subtasks) return null;
  const n = plan.subtasks.length;
  const checks = {
    subtaskCountInRange: n >= (golden.minSubtasks ?? 1) && n <= (golden.maxSubtasks ?? 99),
  };
  if (golden.expectIndependent) {
    checks.independent = plan.subtasks.every((t) => !t.dependsOn?.length);
  }
  if (golden.expectContracts) {
    checks.hasContracts = (plan.contracts?.length ?? 0) > 0;
  }
  if (golden.expectChainDepth) {
    checks.chainDepth = maxChainDepth(plan.subtasks) >= golden.expectChainDepth - 1;
  }
  checks.pass = Object.values(checks).every(Boolean);
  return checks;
}

function maxChainDepth(subtasks) {
  const byId = new Map(subtasks.map((t) => [t.id, t]));
  const memo = new Map();
  function depth(id, stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const task = byId.get(id);
    const deps = task?.dependsOn ?? [];
    const value = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, stack))) : 0;
    stack.delete(id);
    memo.set(id, value);
    return value;
  }
  return Math.max(0, ...subtasks.map((t) => depth(t.id)));
}

function checkContractEntities(plan, brief) {
  const corpus = `${brief.evidence}\n${brief.tree}\n${brief.summary}`;
  let checked = 0;
  let hits = 0;
  for (const contract of plan.contracts ?? []) {
    const tokens = String(contract.definition ?? "")
      .split(/[^A-Za-z0-9_./-]+/)
      .filter((token) => token.length >= 4);
    for (const token of tokens.slice(0, 6)) {
      checked += 1;
      if (corpus.includes(token)) hits += 1;
    }
  }
  return { checked, hits };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runOneCase(task, fixtureName, fixturesRoot, ctx, config, ledger) {
  const repoRoot = join(fixturesRoot, fixtureName);
  const brief = await buildRepoBrief(repoRoot, task.prompt);
  const llm = new InstrumentedLlm(ctx, config, ledger);
  const started = Date.now();
  let error;
  let result;
  try {
    result = await createPlan(task.prompt, brief, [], llm, config);
  } catch (err) {
    error = redactPublicText(err instanceof Error ? err.message : String(err));
  }
  const wallMs = Date.now() - started;

  const row = {
    taskId: task.id,
    fixture: fixtureName,
    category: task.category,
    difficulty: task.difficulty,
    familyId: task.familyId,
    suites: task.suites,
    expectOutcome: task.expectOutcome ?? "plan",
    adversarial: task.adversarial,
    model: ctx.model.provider + "/" + ctx.model.id,
    wallMs,
    cost: llm.usage.cost,
    tokens: llm.usage.input + llm.usage.output,
    schemaRetriesUsed: llm.schemaRetriesUsed,
    modelCalls: llm.calls,
    responses: llm.responses,
    firstPassValid: llm.calls === 1 && !error && Boolean(result),
    error: error ?? null,
    attemptAt: new Date().toISOString(),
  };

  if (error) {
    row.outcome = "error";
  } else if (result && "recommend" in result) {
    row.outcome = "solo";
  } else {
    const validation = validatePlan(result, config.planner.maxSubtasks);
    row.outcome = validation.ok ? "plan" : "invalid";
    row.subtaskCount = result.subtasks?.length ?? 0;
    row.contractCount = result.contracts?.length ?? 0;
    row.golden = scoreGolden(task.golden, result);
    row.contractEntity = checkContractEntities(result, brief);
    row.plan = result;
    if (!validation.ok) {
      row.error = `计划校验失败:\n${validation.errors.join("\n")}`;
      row.outcome = "error";
    }
  }
  row.failClass = classifyFail(row);
  row.qualityPass = qualityPassFor(row);
  return row;
}

function parseArgs(argv) {
  const out = {
    suite: "smoke", retryErrorsOnly: false, maxAttempts: 1, limit: 0,
    category: "", fixture: "", tag: "", dryRun: false, validateOnly: false,
    model: process.env.PI_CAPSTAN_TEST_MODEL, budgetUsd: 1, timeoutSec: 120, maxOutputTokens: 16_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") out.suite = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--budget-usd") out.budgetUsd = Number(argv[++i]);
    else if (a === "--timeout-sec") out.timeoutSec = Number(argv[++i]);
    else if (a === "--max-output-tokens") out.maxOutputTokens = Number(argv[++i]);
    else if (a === "--retry-errors") out.retryErrorsOnly = true;
    else if (a === "--attempts") out.maxAttempts = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--category") out.category = argv[++i];
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--tag") out.tag = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--validate") out.validateOnly = true;
    else throw new Error("Unknown option: " + a);
  }
  if (!["smoke", "core", "full"].includes(out.suite)) throw new Error("Unknown suite: " + out.suite);
  for (const key of ["budgetUsd", "timeoutSec", "maxAttempts"]) {
    if (!Number.isFinite(out[key]) || out[key] <= 0) throw new Error(key + " must be positive.");
  }
  if (!Number.isInteger(out.maxAttempts) || !Number.isInteger(out.limit) || out.limit < 0) throw new Error("attempts/limit must be integers.");
  if (!Number.isInteger(out.maxOutputTokens) || out.maxOutputTokens < 1000 || out.maxOutputTokens > 1_000_000) throw new Error("max-output-tokens must be an integer from 1000 to 1000000.");
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(__dirname, "../..");
const resultsDir = join(__dirname, "results");
const latestPath = join(resultsDir, "baseline-latest.json");
const args = parseArgs(process.argv.slice(2));

if (args.validateOnly) {
  const summary = summarizeCatalog();
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(summary.taskCount === 100 ? 0 : 1);
}

const prior = args.retryErrorsOnly ? JSON.parse(await readFile(latestPath, "utf8")) : undefined;
if (prior && prior.schemaVersion !== 2) throw new Error("Legacy baselines cannot be overlaid. Start a fresh Pi-backed baseline; archived results remain intact.");
const loaded = loadTasks({
  suite: args.retryErrorsOnly ? "full" : args.suite,
  category: args.category || undefined, fixture: args.fixture || undefined,
  tag: args.tag || undefined, limit: args.limit || undefined,
});
const taskById = new Map(loaded.manifest.tasks.map((task) => [task.id, task]));
const targets = prior?.rows.filter((row) => row.outcome === "error") ?? [];
const cases = args.retryErrorsOnly
  ? targets.map((row) => ({ task: taskById.get(row.taskId), fixtureName: row.fixture }))
  : loaded.cases;
if (cases.some((item) => !item.task)) throw new Error("Retry references an unknown task.");
process.stdout.write("suite=" + args.suite + " tasks=" + loaded.manifest.tasks.length + " cases=" + cases.length + "\n");
if (!cases.length) {
  process.stdout.write("No matching cases.\n");
  process.exit(0);
}
if (args.dryRun) {
  for (const { task, fixtureName } of cases) process.stdout.write(task.id + "@" + fixtureName + "\t" + task.category + "\n");
  process.exit(0);
}

const ctx = await createPiContext(args.model);
const modelSpec = ctx.model.provider + "/" + ctx.model.id;
const config = structuredClone(DEFAULT_CONFIG);
config.gate.model = config.planner.model = config.worker.model = modelSpec;
config.planner.timeoutSec = args.timeoutSec;
config.planner.tokenLimit = args.maxOutputTokens;
config.caseStore.enabled = false;
config.run.verifyAllowedPrefixes = [...config.run.verifyAllowedPrefixes, "true", "python", "python3", "node --test"];

const hash = (value) => createHash("sha256").update(value).digest("hex");
async function sourceIdentity() {
  const files = ["index.ts", "package.json", "package-lock.json"];
  async function collect(directory) {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      if (["results", "fixtures", ".git"].includes(entry.name)) continue;
      const relative = directory + "/" + entry.name;
      if (entry.isDirectory()) await collect(relative);
      else if (/\.(?:ts|mjs|json)$/.test(entry.name)) files.push(relative);
    }
  }
  await collect("src");
  await collect("scripts/bench");
  const digest = createHash("sha256");
  for (const file of files.sort()) digest.update(file + "\0").update(await readFile(join(sourceRoot, file)));
  const head = await runCommand("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: sourceRoot });
  return { head: head.stdout.trim(), dirty: Boolean(status.stdout.trim()), contentSha256: digest.digest("hex"), files };
}
const source = await sourceIdentity();
const catalogSha256 = hash(JSON.stringify(loaded.manifest));
const configSha256 = hash(JSON.stringify(config));
if (prior && (prior.model !== modelSpec || prior.catalogSha256 !== catalogSha256 || prior.configSha256 !== configSha256 || prior.source?.contentSha256 !== source.contentSha256)) {
  throw new Error("Retry model/catalog/config/source differs from the baseline. Start a fresh run instead of mixing evidence.");
}
const piPackage = JSON.parse(await readFile(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
const ledger = { cost: 0, limit: args.budgetUsd };
const rows = prior ? structuredClone(prior.rows) : [];
const plannedCases = prior?.plannedCases ?? cases.length;
const startedAt = new Date().toISOString();
const stamp = startedAt.replaceAll(":", "-");
const outPath = join(resultsDir, "baseline-" + (args.retryErrorsOnly ? "retry" : args.suite) + "-" + stamp + ".json");
const fixturesRoot = await mkdtemp(join(tmpdir(), "capstan-bench-"));
await mkdir(resultsDir, { recursive: true });
let stopReason;
let finished = false;

async function save() {
  const summary = {
    schemaVersion: 2, version: loaded.manifest.version,
    suite: prior?.suite ?? args.suite,
    attemptPolicy: "all_attempts_preserved", startedAt, capturedAt: new Date().toISOString(),
    finished, stopReason: stopReason ?? null, model: modelSpec,
    modelInfo: { api: ctx.model.api, baseUrl: ctx.model.baseUrl, cost: ctx.model.cost, maxTokens: ctx.model.maxTokens },
    runtime: { pi: piPackage.version, node: process.version },
    source, catalogSha256, configSha256, config,
    costNote: "Pi catalog estimate; all recorded attempts included, provider billing is authoritative.",
    executionBudgetUsd: args.budgetUsd, executionCost: ledger.cost,
    catalog: summarizeCatalog(), plannedCases, processedCases: rows.length,
    plannedCompletionRate: rows.filter((row) => ["plan", "solo"].includes(row.outcome)).length / plannedCases,
    retriedErrors: targets.length, totals: computeTotals(rows), rows,
  };
  await atomicWriteJson(outPath, summary);
  await atomicWriteJson(latestPath, summary);
  return summary;
}

process.stdout.write("Pi model=" + modelSpec + " budget=$" + args.budgetUsd + "\n");
try {
  await materializeFixtures(fixturesRoot);
  for (let i = 0; i < cases.length; i++) {
    if (ledger.cost >= ledger.limit) { stopReason = "budget"; break; }
    if (i > 0) await sleep(Number(process.env.BENCH_GAP_MS ?? 1000));
    const { task, fixtureName } = cases[i];
    const label = task.id + "@" + fixtureName;
    const idx = rows.findIndex((row) => row.taskId === task.id && row.fixture === fixtureName);
    const attempts = idx >= 0 ? [...rows[idx].attempts] : [];
    let last;
    for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
      if (ledger.cost >= ledger.limit) { stopReason = "budget"; break; }
      if (attempt > 1) await sleep(1000);
      last = await runOneCase(task, fixtureName, fixturesRoot, ctx, config, ledger);
      last.benchAttempt = attempts.length + 1;
      attempts.push(last);
      const row = { ...last, attempts: [...attempts] };
      if (idx >= 0) rows[idx] = row;
      else if (attempt === 1) rows.push(row);
      else rows[rows.length - 1] = row;
      await save();
      process.stdout.write(label + " " + last.outcome + " " + (last.wallMs / 1000).toFixed(1) + "s $" + last.cost.toFixed(4) + " try=" + last.benchAttempt + (last.failClass ? " failure=" + last.failClass : "") + "\n");
      if (["plan", "solo"].includes(last.outcome) || ["auth", "model_unavailable", "budget"].includes(last.failClass)) break;
    }
    if (["auth", "model_unavailable", "budget"].includes(last?.failClass)) { stopReason = last.failClass; break; }
  }
  finished = !stopReason && rows.length === plannedCases;
} catch (error) {
  stopReason = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const summary = await save();
  process.stdout.write(JSON.stringify(summary.totals, null, 2) + "\n");
  process.stdout.write("saved " + outPath + "\n");
  if (!finished || summary.totals.errors || summary.totals.invalid || rows.some((row) => !qualityPassFor(row))) process.exitCode = 1;
  await rm(fixturesRoot, { recursive: true, force: true });
}
