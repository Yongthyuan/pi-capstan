import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { CapstanRun } from "../types.ts";

export type DashboardAction = { type: "close" } | { type: "pause" | "resume" | "abort" | "kill" | "steer" | "detach"; workerId?: string };

export async function showDashboard(ctx: any, getRun: () => CapstanRun | undefined): Promise<DashboardAction> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(renderRunText(getRun()), "info");
    return { type: "close" };
  }
  return ctx.ui.custom((tui: any, theme: Theme, _kb: unknown, done: (action: DashboardAction) => void) => new DashboardComponent(theme, getRun, done, () => tui.requestRender()));
}

export function renderRunText(run?: CapstanRun): string {
  if (!run) return "No active capstan run";
  const done = Object.values(run.workers).filter((worker) => worker.status === "done").length;
  const blocked = Object.values(run.workers).filter((worker) => worker.status === "blocked").length;
  return `capstan ${run.runId} · ${run.phase}${run.partialSuccess ? " (partial)" : ""} · ${done}/${run.plan?.subtasks.length ?? 0} done${blocked ? ` · ${blocked} blocked` : ""} · $${run.totals.cost.toFixed(3)}`;
}

export function widgetLines(run?: CapstanRun): string[] | undefined {
  if (!run || ["done", "failed", "aborted"].includes(run.phase)) return undefined;
  const workers = Object.values(run.workers);
  const done = workers.filter((worker) => worker.status === "done").length;
  const awaiting = workers.filter((worker) => worker.status === "awaiting").length;
  const active = workers.find((worker) => ["working", "fixing", "verifying", "merging"].includes(worker.status));
  return [`◐ capstan ${done}/${run.plan?.subtasks.length ?? 0} · ${active ? `${active.subtaskId} ${active.currentAction}` : run.phase} · $${run.totals.cost.toFixed(3)}${awaiting ? ` · ⚠${awaiting}` : ""}`];
}

class DashboardComponent {
  private selected = 0;
  private readonly theme: Theme;
  private readonly getRun: () => CapstanRun | undefined;
  private readonly done: (action: DashboardAction) => void;
  private readonly rerender: () => void;

  constructor(theme: Theme, getRun: () => CapstanRun | undefined, done: (action: DashboardAction) => void, rerender: () => void) {
    this.theme = theme;
    this.getRun = getRun;
    this.done = done;
    this.rerender = rerender;
  }

  handleInput(data: string): void {
    const workers = Object.values(this.getRun()?.workers ?? {});
    if (matchesKey(data, "escape") || data === "q") return this.done({ type: "close" });
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(Math.max(0, workers.length - 1), this.selected + 1);
    else if (data === "p") return this.done({ type: "pause" });
    else if (data === "r") return this.done({ type: "resume" });
    else if (data === "s" && workers[this.selected]) return this.done({ type: "steer", workerId: workers[this.selected]!.subtaskId });
    else if (data === "t" && workers[this.selected]) return this.done({ type: "detach", workerId: workers[this.selected]!.subtaskId });
    else if (data === "x" || data === "X") return this.done({ type: "abort" });
    else if (data === "k" && workers[this.selected]) return this.done({ type: "kill", workerId: workers[this.selected]!.subtaskId });
    this.rerender();
  }

  render(width: number): string[] {
    const run = this.getRun();
    if (!run) return ["No active capstan run"];
    const w = Math.max(70, Math.min(width, 120));
    const inner = w - 2;
    const row = (value: string) => `${this.theme.fg("border", "│")}${pad(value, inner)}${this.theme.fg("border", "│")}`;
    const lines = [this.theme.fg("border", `╭${"─".repeat(inner)}╮`), row(` ${this.theme.fg("accent", `CAPSTAN · ${run.plan?.taskSummary ?? run.task}`)} · ${run.phase} · $${run.totals.cost.toFixed(3)}`)];
    const workers = Object.values(run.workers);
    workers.forEach((worker, index) => {
      const prefix = index === this.selected ? "▸" : " ";
      const color = worker.status === "done" ? "success" : worker.status === "failed" ? "error" : worker.status === "awaiting" ? "warning" : "text";
      lines.push(row(` ${prefix} ${this.theme.fg(color as any, `${worker.subtaskId} ${worker.status}`)} · ${worker.currentAction} · $${worker.usage.cost.toFixed(3)}`));
      if (index === this.selected && worker.lastText) lines.push(row(`    ${worker.lastText.replace(/\s+/g, " ").slice(0, inner - 6)}`));
    });
    lines.push(row(""), row(" ↑↓ select · s steer · t detach · p pause · r resume · k kill · X abort · q close"), this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {}
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
