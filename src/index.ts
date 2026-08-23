import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { COMPLETIONS, parseCapstanCommand } from "./command.ts";
import { CapstanService } from "./service.ts";
import { assessPiCompatibility } from "./compat.ts";

export type {
  VerificationStrategy,
  SchedulingStrategy,
  CollaborationPrimitive,
  PluginRegistry,
} from "./plugins/index.ts";
export { DefaultPluginRegistry } from "./plugins/index.ts";

export default function capstanExtension(pi: ExtensionAPI) {
  // Workers explicitly disable extension discovery, but this also prevents recursion
  // if a user manually starts a worker without --no-extensions.
  if (process.env.PI_CAPSTAN_WORKER === "1") return;
  const compatibility = assessPiCompatibility(VERSION, pi);
  if (compatibility.level === "unsupported") throw new Error(compatibility.message);

  const service = new CapstanService(pi, getAgentDir(), CONFIG_DIR_NAME);

  pi.registerCommand("capstan", {
    description: "Plan and execute a native multi-agent capstan",
    getArgumentCompletions: (prefix) => {
      const tail = prefix.split(/\s+/).at(-1) ?? "";
      const items = COMPLETIONS.filter((item) => item.startsWith(tail)).map((item) => ({ value: item, label: item }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await service.handle(parseCapstanCommand(args), ctx);
      } catch (error) {
        ctx.ui.notify(`capstan: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerShortcut("ctrl+shift+s", {
    description: "Open capstan dashboard",
    handler: async (ctx) => {
      try {
        await service.handle({ action: "board", task: "", force: false, solo: false, planOnly: false, rest: [], warnings: [] }, ctx as any);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "capstan_delegate",
    label: "Delegate to Capstan",
    description: "Propose and start a multi-agent coding capstan for a task with at least two independent workstreams. Always asks the user to confirm the plan.",
    parameters: Type.Object({ task: Type.String({ description: "Complete task to delegate" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await service.runTask(params.task, ctx, { force: true });
        return { content: [{ type: "text", text: "Capstan planning started; the user confirmation gate remains active." }], details: { accepted: true } };
      } catch (error) {
        return { content: [{ type: "text", text: `Capstan delegation failed: ${error instanceof Error ? error.message : String(error)}` }], details: { accepted: false }, isError: true };
      }
    },
  });

  pi.registerMessageRenderer("capstan-report", (message, { expanded, outputPad }, theme) => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    const rawContent = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const content = expanded ? rawContent : rawContent.split("\n").slice(0, 8).join("\n");
    box.addChild(new Text(`${theme.fg("accent", "[capstan]")} ${content}`, 0, 0));
    return box;
  });

  pi.registerEntryRenderer<{ runId: string; phase: string; outcome?: string }>("capstan-run", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    return new Text(`${theme.fg("accent", "[capstan-run]")} ${data.runId} · ${data.phase}${data.outcome ? ` · ${data.outcome}` : ""}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (compatibility.level === "compatible") ctx.ui.notify(compatibility.message, "warning");
    await service.onSessionStart(ctx);
  });
  pi.on("session_shutdown", () => service.onSessionShutdown());
}
