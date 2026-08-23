# Example Configurations and Extensions

This directory contains ready-to-use examples for common capstan customization scenarios.

## Configuration Examples

Located in [`configs/`](./configs/):

### 1. [high-throughput-refactor.json](./configs/high-throughput-refactor.json)

For large-scale refactoring (50+ files, multiple modules).

**Features**:
- Max 12 parallel subtasks
- 8 concurrent workers
- $40 total budget
- Lightweight verification (typecheck only during merge, full tests at end)

**Use when**: Migrating architecture, renaming patterns across codebase, updating dependencies

**Cost**: ~$30-40 per run

### 2. [high-quality-production.json](./configs/high-quality-production.json)

For critical production features where correctness > cost.

**Features**:
- Best-of-3 competition (3 candidates per task, judge picks winner)
- 3 retries per worker
- Comprehensive verification at all stages
- Fail-fast policy (stop on first failure)

**Use when**: Payment systems, authentication, data migration, security features

**Cost**: ~3x normal (due to best-of-3)

### 3. [untrusted-repository.json](./configs/untrusted-repository.json)

Maximum safety for unfamiliar or untrusted codebases.

**Features**:
- Strict bash mode (blocks interpreter escapes)
- No bash tool; edit/write remain so workers can still change owned files
- Auto-deny all approval requests
- Fail on scope violations (no auto-recovery)
- Branch-only merge (never touches main)
- Verification lanes are `[]` (skip). Does **not** auto-run the repo's own `npm test`

**Use when**: Evaluating unknown projects, security audits, experimental changes

This is still **not** a security sandbox for malware.

**Use when**: Evaluating unknown projects, security audits, experimental changes

**Cost**: Lower (limited capabilities = less token usage)

### 4. [fast-iteration-low-cost.json](./configs/fast-iteration-low-cost.json)

For experimentation and rapid prototyping.

**Features**:
- Only 4 subtasks, 2 concurrent workers
- Low budgets ($0.50 planning, $1 per worker, $5 total)
- Minimal retries
- Case learning enabled (learns for next time)

**Use when**: Proof-of-concepts, throwaway experiments, learning capstan behavior

**Cost**: ~$3-5 per run

## How to Use Config Examples

### Option 1: Copy to Project Config

```bash
# Copy example to your project
cp docs/examples/configs/high-quality-production.json .pi/capstan.json

# Customize as needed
vi .pi/capstan.json
```

### Option 2: Copy to Global Config

```bash
# Use for all projects by default
cp docs/examples/configs/fast-iteration-low-cost.json ~/.pi/agent/capstan.json
```

### Option 3: Merge with Existing Config

```json
// Your existing .pi/capstan.json
{
  "worker": {
    // Your existing worker config
  },
  
  // Merge in example patterns
  "run": {
    "verify": {
      "worker": ["npm test"],
      "integrationLight": ["npm run typecheck"],
      "full": ["npm test", "npm run typecheck", "npm run lint"]
    }
  }
}
```

## Plugin Examples

Located in [`plugins/`](./plugins/) — see also [TEMPLATES.md](./TEMPLATES.md) and [../PLUGINS.md](../PLUGINS.md).

- [incremental-verifier.ts](./plugins/incremental-verifier.ts) — run only affected tests
- [adaptive-scheduler.ts](./plugins/adaptive-scheduler.ts) — adjust concurrency from conflict/cost signals
- [shared-kv-store.ts](./plugins/shared-kv-store.ts) — shared key-value coordination primitive

## Extension Examples

Located in [`extensions/`](./extensions/):

### 1. [custom-db-tools.ts](./extensions/custom-db-tools.ts)

Adds database query and semantic search tools for workers.

**Tools added**:
- `capstan_query_db` - Execute read-only SQL queries
- `capstan_semantic_search` - Natural language code search

**Installation**:
```bash
# 1. Copy to extensions directory
cp docs/examples/extensions/custom-db-tools.ts ~/.pi/agent/extensions/

# 2. Configure in capstan.json
{
  "safetyGuardPath": "~/.pi/agent/extensions/custom-db-tools.ts"
}

# 3. Set up database connection (example)
export DB_URL="postgresql://localhost/myproject"
```

**Use when**: Workers need schema information, table relationships, or sample data

### 2. [custom-validation-policies.ts](./extensions/custom-validation-policies.ts)

Enforces project-specific rules and conventions.

**Policies enforced**:
- Block writes to generated/ directories
- Require --coverage flag for tests
- Enforce React component naming (uppercase)
- Block manual lock file edits
- Block dangerous rm -rf commands

**Installation**:
```bash
# 1. Copy to extensions directory
cp docs/examples/extensions/custom-validation-policies.ts ~/.pi/agent/extensions/

# 2. Configure in capstan.json
{
  "safetyGuardPath": "~/.pi/agent/extensions/custom-validation-policies.ts"
}
```

**Use when**: Enforcing team conventions, preventing common mistakes, ensuring code quality

## How to Customize Extensions

### Add Your Own Tools

```typescript
// In your custom extension
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "capstan_my_tool",
    label: "My Custom Tool",
    description: "What it does",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string" }
      },
      required: ["input"]
    },
    async execute(_id, params) {
      // Your implementation
      return {
        content: [{ type: "text", text: "Result" }]
      };
    }
  } as any);
}
```

### Add Your Own Policies

```typescript
export default function(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("write", event)) {
      // Your validation logic
      if (shouldBlock(event.input.path)) {
        return {
          block: true,
          reason: "Explain why"
        };
      }
    }
  });
}
```

## For Claude: How to Use These Examples

When a user describes their needs, follow this decision tree:

### 1. Identify the Pattern

User says: **"大规模重构"** or **"migrate 50+ files"**
→ Use `high-throughput-refactor.json`

User says: **"生产环境"** or **"critical feature"** or **"must be correct"**
→ Use `high-quality-production.json`

User says: **"不熟悉的项目"** or **"untrusted code"** or **"maximum safety"**
→ Use `untrusted-repository.json`

User says: **"快速试验"** or **"PoC"** or **"low cost"**
→ Use `fast-iteration-low-cost.json`

### 2. Apply the Config

```bash
# Read the example
Read docs/examples/configs/[chosen-pattern].json

# Copy to project
cp docs/examples/configs/[pattern].json .pi/capstan.json

# Explain trade-offs
"这个配置使用 best-of-3 竞争，质量最高但成本约 3 倍。
每个子任务会运行 3 个候选方案，由 reviewer 选择最优的。
总预算 $60，足够处理中型功能。"
```

### 3. Customize if Needed

User says: **"但是我想要 10 个并发 worker"**

```json
// Merge user preference
{
  // Copy from example
  "worker": {
    "bestOfN": 3,
    "maxRetries": 3,
    "perAgentBudgetUsd": 5,
    // Add user override
    "maxConcurrency": 10  // User requested
  }
}
```

### 4. Extension Selection

User says: **"Workers 需要查询数据库"**
→ Use `custom-db-tools.ts`

User says: **"强制所有测试必须有 coverage"**
→ Use `custom-validation-policies.ts`

User says: **"我需要一个自定义工具来..."**
→ Read extension examples, generate new extension based on pattern

## Contributing Your Own Examples

If you create a useful configuration or extension:

1. Test it thoroughly on real projects
2. Document what problem it solves
3. Add clear comments explaining trade-offs
4. Submit a PR to share with the community

## See Also

- [CONFIGURATION.md](../CONFIGURATION.md) - Complete config reference
- [EXTENSION_POINTS.md](../EXTENSION_POINTS.md) - Extension API documentation
- [README.md](../README.md) - Main documentation index
