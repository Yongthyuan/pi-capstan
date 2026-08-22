# FOR_CLAUDE.md — how to configure Capstan

You are configuring **Capstan** (formerly **pi-agent-swarm**), a Pi extension for **controlled parallel coding**.

This is **not** [`@gjczone/pi-swarm`](https://pi.dev/packages/@gjczone/pi-swarm). That package fans items out with a Swarm tool. This package: gate → human-confirmed DAG plan → worktree workers → verify → merge.

## Your job

1. Read this file and [CONFIGURATION.md](./CONFIGURATION.md).
2. Copy a template from [examples/configs/](./examples/configs/) into `<repo>/.pi/swarm.json`.
3. Ask the user to run `/swarm validate`, then `/swarm "task"`.
4. Do **not** invent flags, keys, or plugins. Do **not** skip plan confirmation.

`swarm_delegate` still requires the user to confirm the plan.

## Forbidden (these do not exist)

- `--config`
- `worker.perAgentTokens` (real: `worker.perAgentTokenLimit`)
- `run.customVerifiers`, `run.verificationConfig`, `worker.schedulerStrategy`, `planner.templates`
- `run.verificationStrategy: "incremental"` (if used, it must be a **file path**, and it is optional)
- JSON with `//` comments
- `$schema` unless `docs/schema/swarm-config.schema.json` exists (it does not)

Unknown `--flags` are swallowed into the task text.

## Real commands

```text
/swarm "task" [--force|-f] [--solo] [--plan-only|-n] [--max N] [--budget USD] [--best-of N] [--model provider/id]
/swarm board|pause|resume [runId]|abort|merge [runId]|pr [runId]|replan|clean|replay [runId]
/swarm cases [rate <caseId> +1|-1 | delete <caseId>]
/swarm config | validate | analyze [--limit N] [--recommendations|--summary-only] | status | help
```

Flag mapping:

- `--max` → `worker.maxConcurrency` (1–8), not `planner.maxSubtasks`
- `--budget` → `run.budgetUsd`
- `--model` → `worker.model` only
- `--best-of` → `worker.bestOfN`

## Paths

| What | Where |
|---|---|
| Global config | `~/.pi/agent/swarm.json` |
| Project config | `<repo>/.pi/swarm.json` |
| Run state | `<repo>/.pi/swarm/runs/<runId>/state.json` |
| Report | `<repo>/.pi/swarm/runs/<runId>/report.md` |
| Cases | `~/.pi/agent/swarm/cases` |
| Worktrees | `~/.pi/agent/swarm/worktrees` |

`safetyGuardPath` does **not** expand `~`. Use an absolute path.

## Templates

| User intent | File |
|---|---|
| Large refactor | `examples/configs/high-throughput-refactor.json` |
| Must-be-correct feature | `examples/configs/high-quality-production.json` |
| Untrusted/unfamiliar repo | `examples/configs/untrusted-repository.json` |
| Cheap experiment | `examples/configs/fast-iteration-low-cost.json` |

Copy the JSON as-is (pure JSON). Then change only budget/concurrency if asked.

## Verification contract (this is the product)

- Worker always runs `subtask.acceptance.commands` from the confirmed plan first.
- `run.verify.worker` is only a fallback if acceptance is empty.
- `run.verify.integrationLight` / `full`: `null` = auto-detect, `[]` = skip, `[...]` = run those commands.
- Skip is reported as **跳过**, not a green check.

For production-quality work, set an explicit `run.verify.full` array of allowlisted commands.

## Plan contract (not swarm.json fields)

- Same-wave `ownedPaths` ∪ `generatedPaths` must not overlap or the plan is rejected.
- `sharedPaths` is for lockfiles / generated metadata, not feature code.
- Out-of-scope writes default to `scopeViolationPolicy: "revert"`, then re-verify.
- The user must start / edit / cancel the plan. You cannot bypass that.
- Dirty worktrees only land with `mergeStrategy: "branch"`.

## Plugins (optional, not the main path)

Do not write plugins unless the user asks. If they do:

- Point `run.verificationStrategy` at a real module path (see `examples/plugins/incremental-verifier.ts`).
- The plugin may narrow commands via `selectCommands`. The runtime still executes them through the allowlist. `verify()` is not called.
- Scheduling plugins only change **concurrency width**. They do not reorder the DAG.
- Collaboration plugins currently **do not** inject worker tools.

Prefer `run.verify` and plan `acceptance.commands`.

## After a run

`/swarm analyze` suggests config changes. It does **not** write `swarm.json`. Apply changes only after the user agrees.
