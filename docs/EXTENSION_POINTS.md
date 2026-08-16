# Pi-Swarm Extension Points

> **For Claude**: This document describes how to extend pi-swarm with custom verification strategies, schedulers, and coordination primitives. Read this when you need to implement custom behavior beyond configuration.

## Overview

Pi-swarm is designed to be extended at several architectural layers:

1. **Configuration** - 89 config options in `swarm.json` (see CONFIGURATION.md)
2. **Custom Guards** - Inject custom tools and policies into workers
3. **Verification Strategies** - Plugin-based verification (planned)
4. **Scheduler Strategies** - Custom task scheduling logic (planned)
5. **Coordination Primitives** - New worker collaboration tools (planned)

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
  "safetyGuardPath": "~/.pi/agent/extensions/my-swarm-tools.ts"
}
```

All workers will now have `swarm_query_db` and `swarm_semantic_search` available.

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

## 2. Verification Strategies (Planned)

**Status**: Configuration exists (`run.verify`), but strategies are hardcoded.

**Vision**: Pluggable verification strategies registered via config.

### Current State

```json
{
  "run": {
    "verify": {
      "worker": ["npm test"],
      "integrationLight": ["npm run typecheck"],
      "full": ["npm test", "npm run lint"]
    }
  }
}
```

### Planned: Plugin-Based Verification

```typescript
// Future API (not yet implemented)
export interface VerificationStrategy {
  name: string;
  
  // Select tests to run based on changes
  selectTests(changes: GitDiff): Promise<string[]>;
  
  // Execute verification
  execute(worktree: string, tests: string[]): Promise<VerificationResult>;
  
  // Classify failures
  diagnose(error: VerificationError): FailureCategory;
}

// Register in config
{
  "run": {
    "verificationStrategy": "incremental",  // or "full", "custom"
    "customVerifiers": [
      "./verifiers/incremental-test-selector.ts"
    ]
  }
}
```

**Implementation Roadmap**:
1. Extract verifier.ts hardcoded logic into strategy interface
2. Add strategy loader and registry
3. Implement incremental test selection strategy
4. Document strategy API

## 3. Scheduler Strategies (Planned)

**Status**: DAG scheduling is hardcoded in orchestrator.ts

**Vision**: Pluggable schedulers for different optimization goals.

### Current Behavior

- Static DAG topology
- Slot-based parallelism (up to `maxConcurrency`)
- Dependency-aware advancement
- No dynamic task injection

### Planned: Pluggable Schedulers

```typescript
// Future API (not yet implemented)
export interface SchedulerStrategy {
  name: string;
  
  // Decide which tasks to start next
  schedule(
    available: Subtask[],
    running: Subtask[],
    completed: Subtask[],
    resources: { slots: number; budget: number }
  ): Subtask[];
  
  // Handle dynamic task injection
  inject?(task: Subtask): void;
  
  // Adjust parallelism dynamically
  adjustConcurrency?(metrics: RunMetrics): number;
}

// Register in config
{
  "worker": {
    "schedulerStrategy": "adaptive",  // or "static", "cost-optimal", "custom"
    "customSchedulers": [
      "./schedulers/cost-optimal.ts"
    ]
  }
}
```

**Planned Built-in Strategies**:
- **`static`** - Current behavior (DAG + fixed concurrency)
- **`adaptive`** - Adjust concurrency based on conflict rate
- **`cost-optimal`** - Prioritize cheap tasks first
- **`critical-path`** - Prioritize bottleneck tasks

**Implementation Roadmap**:
1. Extract scheduling logic from orchestrator.ts
2. Define strategy interface
3. Implement adaptive strategy (adjust concurrency on conflict rate)
4. Document strategy API

## 4. Coordination Primitives (Planned)

**Status**: Workers have mailbox (async messages) and contracts (static text).

**Vision**: Rich coordination APIs with request/response, barriers, shared state.

### Current Capabilities

**Mailbox (Async Messages)**:
```typescript
// Worker A
await tools.swarm_send({ to: "st2", message: "Login API ready at /auth/login" });

// Worker B  
const inbox = await tools.swarm_inbox();
// Returns: [{ from: "st1", message: "Login API ready at /auth/login", ts: 1234567890 }]
```

**Contracts (Static Text)**:
```typescript
// Defined in plan
{
  "contracts": [{
    "id": "c1",
    "kind": "interface",
    "definition": "interface AuthService { login(user: string): Promise<Token> }"
  }]
}
```

### Planned: Rich Coordination API

```typescript
// Future API (not yet implemented)

// Request-Response Pattern
const result = await swarm.request({
  to: "st2",
  type: "validate_interface",
  payload: { interfaceName: "AuthService", file: "auth.ts" }
});

// Barrier Synchronization
await swarm.barrier("auth-ready", ["st1", "st2", "st3"]);
// Blocks until all 3 workers call barrier with same name

// Shared Key-Value Store
await swarm.kv.set("jwt-secret", "abc123", { ttl: 3600 });
const secret = await swarm.kv.get("jwt-secret");

// Watch for changes
swarm.kv.watch("schema-version", (version) => {
  console.log("Schema updated to", version);
});

// Dynamic Contract Validation
const valid = await swarm.validateContract({
  contractId: "c1",
  implementation: "./auth.ts"
});
```

**Implementation Roadmap**:
1. Design coordination API interface
2. Implement request-response over mailbox JSONL
3. Implement barrier primitive (requires orchestrator coordination)
4. Implement in-memory KV store (orchestrator-hosted)
5. Document API and examples

## 5. Task Templates (Planned)

**Status**: No template system yet.

**Vision**: Reusable task decomposition templates for common patterns.

### Planned: Template Library

```typescript
// Future API (not yet implemented)

// Template definition
export const oauthTemplate: TaskTemplate = {
  name: "oauth-implementation",
  description: "Implement OAuth 2.0 authentication",
  variables: {
    provider: { type: "string", enum: ["google", "github", "azure"] },
    framework: { type: "string", enum: ["express", "fastify", "next"] }
  },
  generate(vars: { provider: string; framework: string }): SwarmPlan {
    return {
      taskSummary: `Implement ${vars.provider} OAuth with ${vars.framework}`,
      strategy: "Backend → Frontend → Tests",
      contracts: [
        {
          id: "c1",
          kind: "api",
          definition: `POST /auth/${vars.provider}/callback`
        }
      ],
      subtasks: [
        {
          id: "st1",
          title: "OAuth backend",
          goal: `Implement ${vars.provider} OAuth flow with ${vars.framework}`,
          ownedPaths: ["src/auth/**"],
          // ...
        },
        {
          id: "st2",
          title: "Login UI",
          goal: "Create login page with OAuth button",
          ownedPaths: ["src/pages/login.tsx"],
          dependsOn: ["st1"],
          // ...
        }
      ],
      mergeOrder: ["st1", "st2", "st3"]
    };
  }
};

// Usage
{
  "planner": {
    "templates": [
      "./templates/oauth.ts",
      "./templates/crud-api.ts"
    ]
  }
}
```

When planner detects "implement OAuth", it uses template instead of LLM planning.

**Implementation Roadmap**:
1. Design template schema (TypeScript interfaces)
2. Add template registry to planner
3. Implement template matcher (keyword detection)
4. Create 5-10 common templates (OAuth, CRUD, migration, etc.)
5. Allow users to add custom templates

## How Claude Should Use Extension Points

### When to Use Configuration vs Extensions

**Use Configuration** (`swarm.json`) when:
- Adjusting thresholds, limits, timeouts
- Enabling/disabling built-in features
- Selecting from predefined strategies

**Use Custom Guards** when:
- Adding new tools for workers
- Enforcing project-specific policies
- Integrating external services (databases, APIs)

**Use Verification Strategies** (when available) when:
- Implementing incremental test selection
- Custom failure diagnosis
- Project-specific validation logic

**Use Scheduler Strategies** (when available) when:
- Optimizing for specific goals (cost, speed, quality)
- Implementing dynamic parallelism
- Handling complex dependency patterns

**Use Coordination Primitives** (when available) when:
- Workers need synchronous communication
- Shared state is required
- Complex multi-step protocols between workers

### Example: Adding Database Query Tool

User says: "Workers need to query the project database for schema information"

**Your steps**:
1. Create custom guard extension with `swarm_query_db` tool
2. Add `safetyGuardPath` to `.pi/swarm.json`
3. Test with `/swarm` command
4. Observe workers using the new tool in their prompts

### Example: Incremental Verification (Future)

User says: "Only run tests affected by changes"

**Your steps** (when implemented):
1. Read `EXTENSION_POINTS.md` for verification strategy API
2. Implement `IncrementalVerifier` strategy
3. Configure `verificationStrategy: "incremental"` in `swarm.json`
4. Test and verify test selection logic

## Contribution Guidelines

If you implement a reusable extension (custom tool, strategy, template):

1. **Document it** - Add clear comments explaining purpose and usage
2. **Test it** - Verify it works with multiple task types
3. **Share it** - Consider contributing back to pi-swarm
4. **Version it** - Track compatibility with pi-swarm versions

## Status Summary

| Extension Point | Status | ETA | Priority |
|----------------|--------|-----|----------|
| Custom Guards | ✅ Available | Now | - |
| Configuration | ✅ Available | Now | - |
| Verification Strategies | 📋 Planned | Q1 2027 | P0 |
| Scheduler Strategies | 📋 Planned | Q2 2027 | P1 |
| Coordination Primitives | 📋 Planned | Q2 2027 | P1 |
| Task Templates | 📋 Planned | Q3 2027 | P2 |

**P0** = High value, low cost  
**P1** = Medium term refactoring  
**P2** = Long term evolution
