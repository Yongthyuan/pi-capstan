import type { PlanValidation, SwarmPlan, Subtask } from "./types.ts";
import { globToRegExp } from "./utils.ts";
import { isStructurallySafeVerificationCommand } from "./verifier.ts";

export function validatePlan(value: unknown, maxSubtasks = 12): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["计划必须是对象"], warnings, waves: [] };
  const plan = value as Partial<SwarmPlan>;
  if (plan.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (!stringValue(plan.taskSummary)) errors.push("taskSummary 不能为空");
  if (!stringValue(plan.strategy)) errors.push("strategy 不能为空");
  if (!Array.isArray(plan.contracts)) errors.push("contracts 必须是数组");
  if (!Array.isArray(plan.subtasks)) errors.push("subtasks 必须是数组");
  if (!Array.isArray(plan.mergeOrder)) errors.push("mergeOrder 必须是数组");
  if (!Array.isArray(plan.risks)) errors.push("risks 必须是数组");
  if (!Array.isArray(plan.subtasks)) return { ok: false, errors, warnings, waves: [] };
  if (Array.isArray(plan.risks) && plan.risks.some((risk) => !stringValue(risk))) errors.push("risks 必须只包含非空字符串");
  if (Array.isArray(plan.mergeOrder) && plan.mergeOrder.some((id) => !safeIdentifier(id))) errors.push("mergeOrder 含非法 subtask id");
  if (plan.subtasks.length < 2 || plan.subtasks.length > maxSubtasks) errors.push(`subtasks 数量须在 2..${maxSubtasks}`);
  const contractIds = new Set<string>();
  if (Array.isArray(plan.contracts)) {
    for (const contract of plan.contracts) {
      if (!contract || typeof contract !== "object") {
        errors.push("contract 必须是对象");
        continue;
      }
      if (!safeIdentifier(contract.id)) errors.push("contract.id 非法");
      else if (contractIds.has(contract.id)) errors.push(`重复 contract id: ${contract.id}`);
      else contractIds.add(contract.id);
      if (!["interface", "api", "schema", "convention"].includes(contract.kind)) errors.push(`${contract.id ?? "contract"}.kind 非法`);
      if (!stringValue(contract.description) || !stringValue(contract.definition)) errors.push(`${contract.id ?? "contract"} 缺少 description/definition`);
    }
  }
  const ids = new Set<string>();
  for (const task of plan.subtasks) validateSubtask(task, ids, errors);
  if (!plan.subtasks.every(isRunnableSubtaskShape)) return { ok: false, errors, warnings, waves: [] };
  for (const task of plan.subtasks) {
    for (const dependency of task.dependsOn ?? []) if (!ids.has(dependency)) errors.push(`${task.id}: 未知依赖 ${dependency}`);
    for (const contract of task.contracts ?? []) if (!contractIds.has(contract)) errors.push(`${task.id}: 未知契约 ${contract}`);
  }
  const waves = buildWaves(plan.subtasks, errors);
  if (Array.isArray(plan.mergeOrder)) {
    if (new Set(plan.mergeOrder).size !== ids.size || plan.mergeOrder.some((id) => !ids.has(id))) {
      errors.push("mergeOrder 必须恰好包含所有 subtask id");
    } else {
      const rank = new Map(plan.mergeOrder.map((id, index) => [id, index]));
      for (const task of plan.subtasks) {
        for (const dep of task.dependsOn) {
          if ((rank.get(dep) ?? Infinity) > (rank.get(task.id) ?? -1)) errors.push(`mergeOrder 违反依赖 ${dep} -> ${task.id}`);
        }
      }
    }
  }
  for (const wave of waves) {
    for (let left = 0; left < wave.length; left++) {
      for (let right = left + 1; right < wave.length; right++) {
        const a = plan.subtasks.find((task) => task.id === wave[left])!;
        const b = plan.subtasks.find((task) => task.id === wave[right])!;
        if (globsMayOverlap([...a.ownedPaths, ...(a.generatedPaths ?? [])], [...b.ownedPaths, ...(b.generatedPaths ?? [])])) errors.push(`${a.id} 与 ${b.id} 同波次 owned/generated paths 可能重叠`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, waves };
}

function validateSubtask(task: Partial<Subtask>, ids: Set<string>, errors: string[]): void {
  if (!safeIdentifier(task.id)) return void errors.push(`subtask.id 非法: ${String(task.id ?? "")}`);
  if (ids.has(task.id)) errors.push(`重复 subtask id: ${task.id}`);
  ids.add(task.id);
  for (const key of ["title", "goal", "role", "rolePrompt"] as const) if (!stringValue(task[key])) errors.push(`${task.id}.${key} 不能为空`);
  for (const key of ["ownedPaths", "readPaths", "dependsOn", "contracts"] as const) if (!Array.isArray(task[key])) errors.push(`${task.id}.${key} 必须是数组`);
  if (Array.isArray(task.ownedPaths)) {
    if (!task.ownedPaths.length) errors.push(`${task.id}.ownedPaths 不能为空`);
    for (const path of task.ownedPaths) if (!safePathPattern(path)) errors.push(`${task.id}.ownedPaths 含非法路径: ${String(path)}`);
  }
  if (Array.isArray(task.readPaths)) for (const path of task.readPaths) if (!safePathPattern(path)) errors.push(`${task.id}.readPaths 含非法路径: ${String(path)}`);
  for (const key of ["sharedPaths", "generatedPaths"] as const) {
    const paths = task[key];
    if (paths !== undefined && !Array.isArray(paths)) errors.push(`${task.id}.${key} 必须是数组`);
    if (Array.isArray(paths)) for (const path of paths) if (!safePathPattern(path)) errors.push(`${task.id}.${key} 含非法路径: ${String(path)}`);
  }
  if (Array.isArray(task.dependsOn)) for (const id of task.dependsOn) if (!safeIdentifier(id)) errors.push(`${task.id}.dependsOn 含非法 id`);
  if (Array.isArray(task.contracts)) for (const id of task.contracts) if (!safeIdentifier(id)) errors.push(`${task.id}.contracts 含非法 id`);
  if (!task.acceptance || !Array.isArray(task.acceptance.commands) || task.acceptance.commands.length === 0) {
    errors.push(`${task.id}.acceptance.commands 不能为空`);
  } else {
    for (const command of task.acceptance.commands) {
      if (typeof command !== "string" || !isStructurallySafeVerificationCommand(command)) errors.push(`${task.id}.acceptance.commands 含不安全 shell 语法`);
    }
  }
  if (!task.acceptance || !Array.isArray(task.acceptance.criteria)) errors.push(`${task.id}.acceptance.criteria 必须是数组`);
  else if (task.acceptance.criteria.some((criterion) => !stringValue(criterion))) errors.push(`${task.id}.acceptance.criteria 必须只包含非空字符串`);
}

function stringValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function safePathPattern(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

function isRunnableSubtaskShape(task: Partial<Subtask>): task is Subtask {
  return safeIdentifier(task.id)
    && Array.isArray(task.ownedPaths)
    && Array.isArray(task.readPaths)
    && Array.isArray(task.dependsOn)
    && Array.isArray(task.contracts)
    && Boolean(task.acceptance && Array.isArray(task.acceptance.commands) && Array.isArray(task.acceptance.criteria));
}

function buildWaves(subtasks: Subtask[], errors: string[]): string[][] {
  const remaining = new Map(subtasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = Array.from(remaining.values()).filter((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (ready.length === 0) {
      errors.push("subtask DAG 存在环或不可满足依赖");
      break;
    }
    waves.push(ready.map((task) => task.id));
    for (const task of ready) remaining.delete(task.id), done.add(task.id);
  }
  return waves;
}

function staticPrefix(glob: string): string {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  const wildcard = normalized.search(/[?*[]/);
  return (wildcard === -1 ? normalized : normalized.slice(0, wildcard)).replace(/\/$/, "");
}

export function globsMayOverlap(left: string[], right: string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      const pa = staticPrefix(a);
      const pb = staticPrefix(b);
      if (!pa || !pb || pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) return true;
      if (globToRegExp(a).test(pb) || globToRegExp(b).test(pa)) return true;
    }
  }
  return false;
}
