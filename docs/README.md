# Pi-Swarm Documentation Index

> **For Claude**: Start here to understand pi-swarm's capabilities and how to customize it for specific needs.

## Quick Links

- **[CONFIGURATION.md](./CONFIGURATION.md)** - Complete reference for all 89 configuration options
- **[EXTENSION_POINTS.md](./EXTENSION_POINTS.md)** - How to extend swarm with custom tools, strategies, and templates
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System design, components, and data flow (coming soon)

## What is Pi-Swarm?

Pi-swarm is a native multi-agent extension for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It orchestrates complex coding tasks by:

1. **Complexity Gating** - Automatically decides if a task needs multiple agents
2. **Evidence-Based Planning** - Reads your codebase and generates a decomposition plan
3. **Git Worktree Isolation** - Each agent works in its own isolated Git worktree
4. **DAG Scheduling** - Executes independent tasks in parallel, respects dependencies
5. **Contract-First Coordination** - Agents agree on interfaces before implementing
6. **Verification & Merging** - Tests each piece before integrating
7. **Case-Based Learning** - Learns from past runs to improve future plans

## Core Design Philosophy

Pi-swarm follows Pi's minimalist philosophy:

- **Leverage native capabilities** - Git worktrees, Pi RPC, native extensions
- **Zero external dependencies** - No databases, queues, or services
- **Explicit over implicit** - Plans are reviewable, contracts are declared
- **Fail safely** - Branches by default, never force-push, atomic state
- **Learn continuously** - Case library improves planning over time

## For Claude: How to Use This Documentation

When a user asks you to customize or extend swarm:

### Step 1: Understand Their Goal

Ask clarifying questions:
- What kind of task? (refactor, feature, migration)
- Constraints? (budget, time, quality requirements)
- Risk tolerance? (production code vs experiment)

### Step 2: Choose Configuration vs Extension

**Use Configuration** (CONFIGURATION.md) for:
- Adjusting budgets, concurrency, timeouts
- Changing verification commands
- Enabling/disabling features
- Selecting merge strategy

**Use Extension** (EXTENSION_POINTS.md) for:
- Adding new tools for workers
- Custom validation logic
- Project-specific policies
- Integration with external services

### Step 3: Generate & Explain

1. Read the relevant documentation
2. Generate appropriate config or extension code
3. Explain trade-offs clearly
4. Show example usage

### Step 4: Test & Iterate

1. Use `/swarm` command to test
2. Observe results in dashboard
3. Adjust based on feedback
4. Document learnings for next time

## Common Use Cases

### Use Case 1: Large Refactoring

User: "重构整个认证系统，从 JWT 迁移到 OAuth"

**Your approach**:
1. Read CONFIGURATION.md → "High-Throughput Large Refactor" pattern
2. Adjust `maxSubtasks: 10`, `maxConcurrency: 6`, `budgetUsd: 40`
3. Enable verification: `run.verify.worker: ["npm test"]`
4. Explain: "这个配置支持 10 个并行子任务，每次最多 6 个同时运行，总预算 $40"

### Use Case 2: Critical Production Feature

User: "实现支付功能，必须确保质量"

**Your approach**:
1. Read CONFIGURATION.md → "High-Quality Critical Feature" pattern
2. Enable `bestOfN: 3` (run 3 candidates, pick best)
3. Add comprehensive verification at all stages
4. Use `mergeStrategy: "branch"` (never touch main)
5. Explain trade-offs: "质量优先，成本约 3 倍，但通过 best-of-3 竞争确保正确性"

### Use Case 3: Custom Worker Tools

User: "Workers 需要查询项目数据库来获取 schema 信息"

**Your approach**:
1. Read EXTENSION_POINTS.md → "Custom Guard Extensions"
2. Create `~/.pi/agent/extensions/db-tools.ts` with `swarm_query_db` tool
3. Configure `safetyGuardPath` in swarm.json
4. Explain: "每个 worker 现在可以用 swarm_query_db 工具直接查询数据库"

### Use Case 4: Untrusted Repository

User: "在一个不熟悉的项目上试验，要最大安全性"

**Your approach**:
1. Read CONFIGURATION.md → "Untrusted Repository" pattern
2. Enable `strictBash: true` (block interpreter escapes)
3. Remove "bash" from tools array (read-only access)
4. Set `approvalPolicy: "autoDeny"`
5. Force `mergeStrategy: "branch"`
6. Explain: "完全隔离，只能读写文件，不能执行命令，结果在独立分支"

## Configuration Quick Reference

| Aspect | Config Key | Common Values |
|--------|-----------|---------------|
| Parallel workers | `worker.maxConcurrency` | 2-8 (4 default) |
| Max subtasks | `planner.maxSubtasks` | 2-12 (6 default) |
| Total budget | `run.budgetUsd` | $5-$50 ($8 default) |
| Per-worker budget | `worker.perAgentBudgetUsd` | $1-$5 ($2 default) |
| Quality vs cost | `worker.bestOfN` | 1-3 (1 default) |
| Safety level | `worker.strictBash` | true/false |
| Merge strategy | `run.mergeStrategy` | branch/apply/commit |
| Verification | `run.verify.worker` | `["npm test"]` or null |

## Extension Quick Reference

| Need | Solution | Status |
|------|----------|--------|
| Add worker tool | Custom guard extension | ✅ Available |
| Custom validation | Custom guard (tool_call hook) | ✅ Available |
| Incremental tests | Verification strategy | 📋 Planned Q1 2027 |
| Dynamic parallelism | Scheduler strategy | 📋 Planned Q2 2027 |
| Worker sync primitives | Coordination API | 📋 Planned Q2 2027 |
| Reusable patterns | Task templates | 📋 Planned Q3 2027 |

## Command Quick Reference

```bash
# Basic usage
/swarm "实现 OAuth 登录功能"

# With overrides
/swarm "task" --max 8 --budget 20 --model anthropic/claude-opus-4

# Quality mode
/swarm "task" --best-of 3

# Planning only (review before executing)
/swarm "task" --plan-only

# Force swarm (skip complexity gate)
/swarm "task" --force

# Solo mode (pass to main agent, no swarm)
/swarm "task" --solo

# Management commands
/swarm board              # Open dashboard
/swarm pause              # Pause active run
/swarm resume [runId]     # Resume paused/interrupted run
/swarm abort              # Abort active run
/swarm merge [runId]      # Manually merge completed run
/swarm pr [runId]         # Create pull request
/swarm cases              # List case library
/swarm config             # Generate project config template
```

## Architecture Overview

```
User
  ↓
/swarm "task"
  ↓
Gate (Simple? → Pass to main agent)
  ↓
Planner (Repo map + Cases → SwarmPlan)
  ↓
User Reviews Plan
  ↓
Orchestrator
  ├─ Worker 1 (Git worktree A)
  ├─ Worker 2 (Git worktree B)
  └─ Worker 3 (Git worktree C)
  ↓
Verifier (Test each worker)
  ↓
Merger (Incremental integration)
  ↓
Final Verification
  ↓
Landing (Branch/Apply/Commit)
  ↓
Report (Injected into main session)
```

## Key Differentiators

Compared to other multi-agent frameworks:

1. **True isolation** - Git worktrees + process isolation (not virtual)
2. **Git-native versioning** - Automatic history, diff, rollback
3. **Contract-first** - Explicit interfaces with scope enforcement
4. **DAG auto-parallelism** - Explicit dependencies, automatic scheduling
5. **Case-based learning** - Continuous improvement from past runs
6. **Zero infrastructure** - No Redis, databases, or external services

## Getting Help

1. **Read the docs** - CONFIGURATION.md and EXTENSION_POINTS.md cover 95% of use cases
2. **Check examples** - See "Common Configuration Patterns" in CONFIGURATION.md
3. **Inspect state** - Use `/swarm board` to see live status
4. **Review logs** - Check `.pi/swarm/runs/<runId>/logs/` for detailed traces
5. **Case library** - Use `/swarm cases` to see learned patterns

## Version

Current: **v0.6.0**

Compatibility: Pi coding agent `>=0.84.1`

## License

MIT
