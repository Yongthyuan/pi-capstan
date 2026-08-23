import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { GateResult, CapstanPlan } from "../types.ts";
import { validatePlan } from "../plan-validation.ts";

export interface ReviewResult {
  plan?: CapstanPlan;
  edits: string[];
}

export async function reviewPlan(ctx: ExtensionContext, plan: CapstanPlan, gate: GateResult, maxSubtasks: number): Promise<ReviewResult> {
  let current = plan;
  const edits: string[] = [];
  while (true) {
    let action: "run" | "edit" | "cancel";
    if (ctx.mode === "tui") {
      action = await ctx.ui.custom((tui, theme, _keybindings, done) => new PlanComponent(theme, current, gate, (value) => done(value), () => tui.requestRender()));
    } else {
      const confirmed = await ctx.ui.confirm("Capstan 计划确认", summarizePlan(current, gate));
      action = confirmed ? "run" : "cancel";
    }
    if (action === "cancel") return { edits };
    if (action === "run") return { plan: current, edits };
    const edited = await ctx.ui.editor("编辑 CapstanPlan JSON", JSON.stringify(current, null, 2));
    if (!edited) continue;
    try {
      const candidate = JSON.parse(edited) as CapstanPlan;
      const validation = validatePlan(candidate, maxSubtasks);
      if (!validation.ok) {
        ctx.ui.notify(`计划无效: ${validation.errors.join("; ")}`, "error");
        continue;
      }
      current = candidate;
      edits.push("手工编辑完整计划");
    } catch (error) {
      ctx.ui.notify(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

function summarizePlan(plan: CapstanPlan, gate: GateResult): string {
  return [`判定: ${gate.reason}`, `策略: ${plan.strategy}`, ...plan.subtasks.map((task) => `${task.id} ${task.title} · owns ${task.ownedPaths.join(",")} · deps ${task.dependsOn.join(",") || "-"}`)].join("\n");
}

class PlanComponent {
  private selected = 0;
  private readonly actions = ["run", "edit", "cancel"] as const;
  private readonly theme: Theme;
  private readonly plan: CapstanPlan;
  private readonly gate: GateResult;
  private readonly done: (value: "run" | "edit" | "cancel") => void;
  private readonly rerender: () => void;

  constructor(theme: Theme, plan: CapstanPlan, gate: GateResult, done: (value: "run" | "edit" | "cancel") => void, rerender: () => void) {
    this.theme = theme;
    this.plan = plan;
    this.gate = gate;
    this.done = done;
    this.rerender = rerender;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.done("cancel");
    if (matchesKey(data, "left") || matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "right") || matchesKey(data, "down")) this.selected = Math.min(this.actions.length - 1, this.selected + 1);
    else if (matchesKey(data, "return")) return this.done(this.actions[this.selected]!);
    this.rerender();
  }

  render(width: number): string[] {
    const w = Math.max(60, Math.min(width, 110));
    const inner = w - 2;
    const row = (value: string) => `${this.theme.fg("border", "│")}${pad(value, inner)}${this.theme.fg("border", "│")}`;
    const lines = [this.theme.fg("border", `╭${"─".repeat(inner)}╮`), row(` ${this.theme.fg("accent", `CAPSTAN 方案 · ${this.plan.taskSummary}`)}`), row(` 判定: ${this.gate.reason}`), row(` 策略: ${this.plan.strategy}`), row("")];
    for (const task of this.plan.subtasks) {
      lines.push(row(` ${this.theme.fg("accent", task.id)} ${task.title} · owns ${task.ownedPaths.join(", ")}`));
      lines.push(row(`    deps ${task.dependsOn.join(",") || "-"} · verify ${task.acceptance.commands.join(" && ")}`));
    }
    lines.push(row(""));
    const labels = ["开始", "编辑 JSON", "取消"].map((label, index) => index === this.selected ? this.theme.fg("accent", `[ ${label} ]`) : `[ ${label} ]`);
    lines.push(row(` ${labels.join("   ")}`), this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {}
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
