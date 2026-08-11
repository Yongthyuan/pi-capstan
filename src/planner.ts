import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { CaseRecord, SwarmConfig, SwarmPlan } from "./types.ts";
import { validatePlan } from "./plan-validation.ts";
import { readTextIfPresent, runCommand, tokenizeTask, truncateTail } from "./utils.ts";
import { JsonResponseError, type PiLlmClient } from "./llm.ts";

export interface RepoBrief {
  repoRoot: string;
  fileCount: number;
  languages: string[];
  frameworks: string[];
  tree: string;
  evidence: string;
  summary: string;
}

export async function buildRepoBrief(repoRoot: string, task: string, maxChars = 18_000): Promise<RepoBrief> {
  const files = await listRepoFiles(repoRoot);
  const extensions = new Map<string, number>();
  for (const file of files) {
    const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
    if (ext) extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
  }
  const languages = Array.from(extensions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ext]) => ext);
  const frameworks = inferFrameworks(files);
  const tree = buildTree(files, 140);
  const taskTokens = expandQueryTokens(task);
  const manifests = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md", "AGENTS.md"];
  const candidates = new Set(manifests.filter((file) => files.includes(file)));
  for (const file of files) {
    const lower = file.toLowerCase();
    if (taskTokens.some((token) => lower.includes(token.toLowerCase()))) candidates.add(file);
    if (candidates.size >= 24) break;
  }
  let rgAvailable = true;
  for (const token of taskTokens.slice(0, 8)) {
    try {
      const hits = await runCommand("rg", ["-l", "-i", "-F", token, "--glob", "!.git/**", "--glob", "!node_modules/**", "--glob", "!dist/**", "."], { cwd: repoRoot, timeoutMs: 5_000 });
      if (hits.exitCode > 1) continue;
      for (const hit of hits.stdout.split("\n").map((item) => item.replace(/^\.\//, "")).filter(Boolean)) {
        if (files.includes(hit)) candidates.add(hit);
        if (candidates.size >= 48) break;
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      rgAvailable = false;
      break;
    }
  }
  if (!rgAvailable) {
    for (const file of files) {
      const content = await readTextIfPresent(join(repoRoot, file), 64_000);
      const lower = content.toLowerCase();
      if (taskTokens.some((token) => lower.includes(token.toLowerCase()))) candidates.add(file);
      if (candidates.size >= 48) break;
    }
  }
  const contentCache = new Map<string, string>();
  const contentFor = async (file: string) => {
    if (!contentCache.has(file)) contentCache.set(file, await readTextIfPresent(join(repoRoot, file), 64_000));
    return contentCache.get(file)!;
  };
  for (const file of [...candidates]) {
    const content = await contentFor(file);
    for (const neighbor of structuralNeighbors(file, content, files)) candidates.add(neighbor);
  }
  const ranked = await Promise.all([...candidates].map(async (file) => ({ file, content: await contentFor(file) })));
  ranked.sort((a, b) => relevanceScore(b.file, b.content, taskTokens) - relevanceScore(a.file, a.content, taskTokens) || a.file.localeCompare(b.file));
  let evidence = "";
  for (const { file, content } of ranked) {
    if (!content) continue;
    evidence += `\n--- ${file} ---\n${selectEvidence(content, taskTokens, 90)}\n`;
    if (evidence.length >= maxChars) break;
  }
  evidence = evidence.slice(0, maxChars);
  return {
    repoRoot,
    fileCount: files.length,
    languages,
    frameworks,
    tree,
    evidence,
    summary: `${files.length} files; languages=${languages.join(",") || "unknown"}; frameworks=${frameworks.join(",") || "unknown"}`,
  };
}

function expandQueryTokens(task: string): string[] {
  const expanded = new Set<string>();
  for (const token of tokenizeTask(task)) {
    if (token.length >= 3) expanded.add(token.toLowerCase());
    for (const part of token.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[./_-]+/)) if (part.length >= 3) expanded.add(part.toLowerCase());
  }
  return [...expanded];
}

function relevanceScore(file: string, content: string, tokens: string[]): number {
  const lowerPath = file.toLowerCase();
  const lower = content.toLowerCase();
  let score = /(?:^|\/)(?:readme|agents|package|pyproject|cargo|go\.mod)/i.test(file) ? 1 : 0;
  for (const token of tokens) {
    if (lowerPath === token || lowerPath.endsWith(`/${token}`)) score += 10;
    else if (lowerPath.includes(token)) score += 5;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = lower.match(new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "gu"))?.length ?? 0;
    score += Math.min(5, count);
    if (new RegExp(`\\b(?:class|interface|type|function|def|struct|enum)\\s+${escaped}\\b`, "iu").test(content)) score += 8;
  }
  return score;
}

function structuralNeighbors(file: string, content: string, files: string[]): string[] {
  const result = new Set<string>();
  const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const stem = basename(file).replace(/\.(?:test|spec)?\.[^.]+$/, "").replace(/\.[^.]+$/, "");
  for (const candidate of files) {
    const candidateStem = basename(candidate).replace(/\.(?:test|spec)?\.[^.]+$/, "").replace(/\.[^.]+$/, "");
    if (candidate !== file && candidateStem === stem) result.add(candidate);
  }
  for (const match of content.matchAll(/(?:from\s+|require\s*\(|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = join(directory, match[1]!).replaceAll("\\", "/").replace(/^\.\//, "");
    for (const candidate of files) if (candidate === base || candidate.startsWith(`${base}.`) || candidate.startsWith(`${base}/index.`)) result.add(candidate);
  }
  return [...result].slice(0, 24);
}

async function listRepoFiles(repoRoot: string): Promise<string[]> {
  try {
    const git = await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot });
    if (git.exitCode === 0 && git.stdout.trim()) return git.stdout.trim().split("\n").filter(Boolean);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const output: string[] = [];
  async function walk(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build", ".venv"].includes(entry.name)) continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path);
      else output.push(relative(repoRoot, path).replaceAll("\\", "/"));
      if (output.length >= 5_000) return;
    }
  }
  await walk(repoRoot);
  return output;
}

function selectEvidence(content: string, taskTokens: string[], maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return lines.map((line, index) => `${index + 1}: ${line}`).join("\n");
  const selected = new Set<number>();
  const structural = /\b(?:export|class|interface|type|function|def|struct|enum|import|require|describe|test|it|route|handler|command)\b/i;
  for (let index = 0; index < lines.length; index++) {
    const lower = lines[index]!.toLowerCase();
    if (structural.test(lines[index]!) || taskTokens.some((token) => lower.includes(token.toLowerCase()))) {
      for (let cursor = Math.max(0, index - 2); cursor <= Math.min(lines.length - 1, index + 3); cursor++) selected.add(cursor);
    }
    if (selected.size >= maxLines) break;
  }
  if (selected.size < Math.min(24, maxLines)) for (let index = 0; index < Math.min(lines.length, maxLines - selected.size); index++) selected.add(index);
  return Array.from(selected).sort((a, b) => a - b).slice(0, maxLines).map((index) => `${index + 1}: ${lines[index]}`).join("\n");
}

function inferFrameworks(files: string[]): string[] {
  const result: string[] = [];
  const names = new Set(files.map((file) => basename(file)));
  if (names.has("package.json")) result.push("node");
  if (files.some((file) => /(?:^|\/)next\.config\./.test(file))) result.push("nextjs");
  if (files.some((file) => /(?:^|\/)vite\.config\./.test(file))) result.push("vite");
  if (names.has("pyproject.toml") || names.has("requirements.txt")) result.push("python");
  if (names.has("Cargo.toml")) result.push("rust");
  if (names.has("go.mod")) result.push("go");
  return result;
}

function buildTree(files: string[], maxLines: number): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/");
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/…` : file;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).slice(0, maxLines).map(([path, count]) => (count > 1 ? `${path} (${count})` : path)).join("\n");
}

export function plannerPrompt(task: string, brief: RepoBrief, cases: CaseRecord[], maxSubtasks: number, modelNames: string[], verificationPrefixes: string[]): string {
  const prior = cases.length
    ? `\nPrior decompositions (treat negative examples as patterns to avoid):\n${cases.map((item) => `- [${item.rating.explicit * 2 + item.rating.implicit < 0 ? "negative" : "positive"}] ${item.taskText}: ${item.strategy}; roles=${item.planSkeleton.roles.join(",")}; outcome=${item.outcome}; score=${item.rating.explicit * 2 + item.rating.implicit}`).join("\n")}`
    : "";
  return `You are the team-lead planner of a coding-agent swarm. Create an evidence-grounded plan for independent workers in isolated git worktrees.

TASK
${task}

REPOSITORY SUMMARY
${brief.summary}

TREE
${brief.tree}

TASK-RELEVANT SOURCE EVIDENCE
${brief.evidence}${prior}

AVAILABLE MODELS
${modelNames.join("\n") || "use current model"}

ALLOWED VERIFICATION COMMAND PREFIXES
${verificationPrefixes.join("\n")}

HARD RULES
1. Contracts must match supplied source evidence. Do not invent signatures. If no shared interface/API/schema/convention is needed, use contracts: []. Do not create contracts for paths, evidence, or commands.
2. Every contract object has exactly id, kind, description, definition. kind is one of interface, api, schema, convention.
3. Parallel subtasks must have exclusive ownedPaths. Use sharedPaths only for unavoidable shared metadata such as lockfiles, and generatedPaths only for deterministic generated artifacts.
4. Every subtask has runnable acceptance commands beginning with an allowed prefix. Never use pipes, redirects, shell operators, substitutions, or multiline commands.
5. Identifiers match [A-Za-z0-9][A-Za-z0-9_-]{0,63}. Paths are relative and contain no parent traversal segment.
6. Use 2..${maxSubtasks} subtasks, a shallow DAG, and a mergeOrder that respects dependencies.
7. If the work is not genuinely parallelizable, return {"recommend":"solo","reason":"..."}.
8. rolePrompt states mission, scope, constraints, and requires a Completion Report.

Return JSON only. Use this exact structural schema:
{"schemaVersion":1,"taskSummary":"...","strategy":"...","contracts":[{"id":"contract_id","kind":"interface","description":"...","definition":"..."}],"subtasks":[{"id":"worker_id","title":"...","goal":"...","role":"...","rolePrompt":"...","ownedPaths":["relative/path/**"],"sharedPaths":[],"generatedPaths":[],"readPaths":[],"dependsOn":[],"contracts":[],"acceptance":{"commands":["allowed command"],"criteria":["observable result"]},"model":"optional provider/model","estTokens":10000}],"mergeOrder":["worker_id"],"risks":["..."]}`;
}

export async function createPlan(
  task: string,
  brief: RepoBrief,
  cases: CaseRecord[],
  llm: PiLlmClient,
  config: SwarmConfig,
): Promise<SwarmPlan | { recommend: "solo"; reason: string }> {
  const prompt = plannerPrompt(task, brief, cases, config.planner.maxSubtasks, llm.availableModels().map((model) => `${model.provider}/${model.id}`), config.run.verifyAllowedPrefixes);
  let result: SwarmPlan | { recommend: "solo"; reason: string } | undefined;
  let repairRaw = "";
  let repairErrors: string[] = [];
  for (let attempt = 0; attempt <= config.planner.schemaRetries; attempt++) {
    try {
      result = attempt === 0
        ? await llm.plan(prompt)
        : await llm.repairPlan(truncateTail(repairRaw, 12_000), repairErrors, prompt);
    } catch (error) {
      if (!(error instanceof JsonResponseError)) throw error;
      repairRaw = error.raw;
      repairErrors = [error.message];
      if (attempt >= config.planner.schemaRetries) throw new Error(`计划 JSON 修复失败: ${error.message}`);
      continue;
    }
    if ("recommend" in result) return result;
    const validation = validatePlan(result, config.planner.maxSubtasks);
    if (validation.ok) return result;
    if (attempt >= config.planner.schemaRetries) throw new Error(`计划校验失败:\n${validation.errors.join("\n")}`);
    repairRaw = JSON.stringify(result);
    repairErrors = validation.errors;
  }
  throw new Error("无法生成有效计划");
}
