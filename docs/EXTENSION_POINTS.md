# Pi Agent Swarm Extension Points

> **For Claude**: Prefer [CONFIGURATION.md](./CONFIGURATION.md). Custom **guards** are the supported extension. Plugin strategies exist but are optional and partially wired — do not generate them unless the user asks.

## Overview

1. **Configuration** — 51 leaf keys in `swarm.json`
2. **Custom Guards** — extra worker tools via `safetyGuardPath` (absolute path)
3. **Verification plugin** — optional file path on `run.verificationStrategy` (worker lane; gets real git porcelain diff)
4. **Scheduling plugin** — optional file path; **only changes concurrency**, does not reorder the DAG
5. **Collaboration plugins** — may load; **do not inject worker tools yet**. Use `swarm_send` / `swarm_inbox`.

Task templates are the only truly planned feature.

## 1. Custom Guard Extensions (Available Now)

Guards are Pi extensions loaded into each worker to enforce scope and provide tools.

### Built-in Worker Tools

Every worker automatically gets these tools via generated guards:

- **`swarm_send`** - Send message to peer worker
- **`swarm_inbox`** - Read inbox from peers
- **`swarm_fs`** - Scoped filesystem ops (mkdir/touch/remove/move/copy)

### Adding Custom Worker Tools

You can inject additional tools into all workers by creating a custom guard extension:

**Step 1: Create Custom Guard**

```typescript
// ~/.pi/agent/extensions/my-swarm-tools.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function(pi: ExtensionAPI) {
  // Custom tool: Query project database
  pi.registerTool({
    name: "swarm_query_db",
    label: "Query Project Database",
    description: "Execute read-only SQL query against project database",
    parameters: Type.Object({
      query: Type.String({ description: "SELECT query to execute" })
    }),
    async execute(_id, params) {
      // Your implementation
      const results = await executeQuery(params.query);
      return {
        content: [{ type: "text", text: JSON.stringify(results) }]
      };
    }
  });

  // Custom tool: Semantic code search
  pi.registerTool({
    name: "swarm_semantic_search",
    label: "Semantic Code Search",
    description: "Search codebase using natural language",
    parameters: Type.Object({
      query: Type.String()
    }),
    async execute(_id, params) {
      // Your implementation
      const matches = await semanticSearch(params.query);
      return {
        content: [{ type: "text", text: formatMatches(matches) }]
      };
    }
  });
}
```

**Step 2: Configure Pi-Swarm to Load It**

```json
{
  "safetyGuardPath": "/absolute/path/to/my-swarm-tools.ts"
}
```

All workers will now have `swarm_query_db` and `swarm_semantic_search` available. `safetyGuardPath` does not expand `~`.

### Custom Scope Policies

You can also use guards to enforce project-specific constraints:

```typescript
export default function(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    // Block writes to generated files
    if (isToolCallEventType("write", event)) {
      if (event.input.path.includes("/generated/")) {
        return {
          block: true,
          reason: "Cannot write to generated files"
        };
      }
    }

    // Require specific test patterns
    if (isToolCallEventType("bash", event)) {
      if (event.input.command.includes("npm test") &&
          !event.input.command.includes("--coverage")) {
        return {
          block: true,
          reason: "Tests must run with --coverage flag"
        };
      }
    }
  });
}
```

## 2. Verification Strategies (Optional, worker lane)

The runtime already wires `selectCommands` (real git porcelain) and `classifyFailure`.
Selected commands always execute through `verifyCommands` — plugins cannot bypass the syntax gate or prefix allowlist. `verify()` is not called.

Empty command lists are **跳过**, not a green pass.

## 3. Scheduler Strategies (Optional, concurrency only)

`schedule().batches` is advisory **width**. DAG order stays `dependsOn`. `adjust()` is not called at startup.

## 4. Coordination Primitives (Loaded, not injected)

Collaboration plugins may load. Their `getTools()` are **not** injected. Workers use `swarm_send` / `swarm_inbox`.

## 5. Task Templates (Planned)

Copy `docs/examples/configs/*`. There is no template runtime.

## How Claude Should Use Extension Points

### When to Use Configuration vs Extensions

**Use Configuration** (`swarm.json`) when:
- Adjusting thresholds, limits, timeouts
- Setting `run.verify` lanes (`null` / `[]` / command arrays)

**Use Custom Guards** when:
- Adding new tools for workers
- Enforcing project-specific policies

**Use a verification plugin** (optional) when the user asks to narrow worker tests. Point `run.verificationStrategy` at a **file path**.

Do not invent `customVerifiers`, `schedulerStrategy`, or `"incremental"` enums.

### Example: Adding Database Query Tool

User says: "Workers need to query the project database for schema information"

**Your steps**:
1. Create custom guard extension with `swarm_query_db` tool
2. Add an **absolute** `safetyGuardPath` to `.pi/swarm.json` (`~` is not expanded)
3. Test with `/swarm` command
4. Observe workers using the new tool in their prompts

### Example: Incremental Verification

User says: "Only run tests affected by changes"

**Your steps**:
1. Copy `docs/examples/plugins/incremental-verifier.ts` and load it as a module
2. Set `run.verificationStrategy` to that **file path** (not the string `"incremental"`)
3. Keep `run.verify` as the command source; the plugin only narrows the list
4. The runtime still runs commands through the allowlist

## Contribution Guidelines

If you implement a reusable extension (custom tool or plugin):

1. **Document it** — match the runtime contract
2. **Test it** — verify skip vs detect vs explicit commands
3. **Do not** claim APIs that are not wired

## Status Summary

| Extension Point | Status |
|----------------|--------|
| Custom Guards | Available |
| Configuration | Available (51 leaf keys) |
| Verification plugin | Optional; `selectCommands` + `classifyFailure`; `verify()` unused |
| Scheduling plugin | Optional; concurrency width only |
| Collaboration plugins | Load only; tools not injected |
| Task Templates | Planned; copy example configs |
