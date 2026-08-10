import type { ParsedSwarmCommand } from "./types.ts";

const ACTIONS = new Set(["board", "pause", "resume", "abort", "merge", "clean", "cases", "replay", "config", "status", "help"]);

export function splitArgs(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) result.push(current), (current = "");
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("未闭合的引号");
  if (current) result.push(current);
  return result;
}

export function parseSwarmCommand(input: string): ParsedSwarmCommand {
  const tokens = splitArgs(input);
  const parsed: ParsedSwarmCommand = {
    action: "run",
    task: "",
    force: false,
    solo: false,
    planOnly: false,
    rest: [],
  };
  if (tokens[0] && ACTIONS.has(tokens[0])) {
    parsed.action = tokens.shift() as ParsedSwarmCommand["action"];
    parsed.rest = tokens;
    return parsed;
  }
  const task: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--force" || token === "-f") parsed.force = true;
    else if (token === "--solo") parsed.solo = true;
    else if (token === "--plan-only" || token === "-n") parsed.planOnly = true;
    else if (token === "--max") parsed.max = parsePositive(tokens[++index], "--max");
    else if (token === "--budget") parsed.budget = parsePositive(tokens[++index], "--budget");
    else if (token === "--model") {
      parsed.model = tokens[++index];
      if (!parsed.model) throw new Error("--model 缺少值");
    } else task.push(token);
  }
  parsed.task = task.join(" ").trim();
  if (!parsed.task) parsed.action = "help";
  return parsed;
}

function parsePositive(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} 需要正数`);
  return number;
}

export const COMPLETIONS = [
  "board",
  "pause",
  "resume",
  "abort",
  "merge",
  "clean",
  "cases",
  "replay",
  "config",
  "status",
  "help",
  "--force",
  "--solo",
  "--plan-only",
  "--max",
  "--budget",
  "--model",
];
