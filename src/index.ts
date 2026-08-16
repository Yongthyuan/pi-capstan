import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { COMPLETIONS, parseSwarmCommand } from "./command.ts";
import { SwarmService } from "./service.ts";
import { assessPiCompatibility } from "./compat.ts";

export type {
  VerificationStrategy,
  SchedulingStrategy,
  CollaborationPrimitive,
  PluginRegistry,
} from "./plugins/index.ts";
export { DefaultPluginRegistry } from "./plugins/index.ts";

export default function swarmExtension(pi: ExtensionAPI) {
  // Workers explicitly disable extension discovery, but this also prevents recursion
  // if a user manually starts a worker without --no-extensions.
  if (process.env.PI_SWARM_WORKER === "1") return;
  const compatibility = assessPiCompatibility(VERSION, pi);
  if (compatibility.level === "unsupported") throw new Error(compatibility.message);

  const service = new SwarmService(pi, getAgentDir(), CONFIG_DIR_NAME);

  pi.registerCommand("swarm", {
    description: "Plan and execute a native multi-agent swarm",
    getArgumentCompletions: (prefix) => {
      const tail = prefix.split(/\s+/).at(-1) ?? "";
      const items = COMPLETIONS.filter((item) => item.startsWith(tail)).map((item) => ({ value: item, label: item }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await service.handle(parseSwarmCommand(args), ctx);
      } catch (error) {
        ctx.ui.notify(`swarm: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerShortcut("ctrl+shift+s", {
    description: "Open swarm dashboard",
    handler: async (ctx) => {
      try {
        await service.handle({ action: "board", task: "", force: false, solo: false, planOnly: false, rest: [], warnings: [] }, ctx as any);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "swarm_delegate",
    label: "Delegate to Swarm",
    description: "Propose and start a multi-agent coding swarm for a task with at least two independent workstreams. Always asks the user to confirm the plan.",
    parameters: Type.Object({ task: Type.String({ description: "Complete task to delegate" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await service.runTask(params.task, ctx, { force: true });
        return { content: [{ type: "text", text: "Swarm planning started; the user confirmation gate remains active." }], details: { accepted: true } };
      } catch (error) {
        return { content: [{ type: "text", text: `Swarm delegation failed: ${error instanceof Error ? error.message : String(error)}` }], details: { accepted: false }, isError: true };
      }
    },
  });

  pi.registerMessageRenderer("swarm-report", (message, { expanded, outputPad }, theme) => {
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    const rawContent = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const content = expanded ? rawContent : rawContent.split("\n").slice(0, 8).join("\n");
    box.addChild(new Text(`${theme.fg("accent", "[swarm]")} ${content}`, 0, 0));
    return box;
  });

  pi.registerEntryRenderer<{ runId: string; phase: string; outcome?: string }>("swarm-run", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    return new Text(`${theme.fg("accent", "[swarm-run]")} ${data.runId} · ${data.phase}${data.outcome ? ` · ${data.outcome}` : ""}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (compatibility.level === "compatible") ctx.ui.notify(compatibility.message, "warning");
    await service.onSessionStart(ctx);
  });
  pi.on("session_shutdown", () => service.onSessionShutdown());
}
