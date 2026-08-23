# Capstan

> **Many hands. One winch. Total control.**

[![CI](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml/badge.svg)](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-58A6FF.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-3FB950.svg)](./package.json)
[![Pi](https://img.shields.io/badge/Pi-%E2%89%A50.84.1-8957E5.svg)](https://github.com/badlogic/pi-mono)

**Capstan runs several AI coding agents on your repository at the same time — without letting go of the wheel.** Plans are reviewed before money is spent, every worker is isolated in its own Git worktree, costs are hard-capped, and only verified results get merged. It is a [Pi](https://github.com/badlogic/pi-mono) extension, formerly named *pi-agent-swarm*.

<!-- Drop a demo recording at docs/assets/demo.gif, then uncomment:
<p align="center"><img src="docs/assets/demo.gif" alt="Capstan: plan → approve → parallel workers → verified merge" width="720"></p>
-->

## The problem

One coding agent is slow. Five coding agents are chaos: they edit the same files, run your test suite over each other, spend tokens nobody counted, and land half-reviewed changes straight onto your branch.

Capstan's answer is a pipeline, not a free-for-all:

```text
/capstan "add OAuth login, write tests, update the README"
   │
   ├─ 1. GATE      trivial request? it runs solo — no capstan, no extra cost
   ├─ 2. PLAN      a planner reads your repo and proposes a task DAG
   ├─ 3. CONFIRM   you review the plan (tasks, order, acceptance checks) — nothing spent yet
   ├─ 4. BUILD     up to 8 workers, each in its own Git worktree, owning its own files
   ├─ 5. VERIFY    worker output and the merged tree must pass allowlisted checks
   └─ 6. LAND      last-green results merge to an integration branch; PR when you say so
```

## Quick start

```bash
pi install npm:pi-capstan
```

Restart Pi, then just talk to it:

```text
/capstan "implement the OAuth backend, the login page, tests, and docs"
```

You will see the plan first. Approve it and watch the workers fan out on the dashboard; decline it and nothing was spent. **Zero configuration required** — safe defaults ship enabled. When you want to tune concurrency, budgets, or verification, run `/capstan config`; most people never do.

## What you get

- **Nothing runs without your yes.** Every capstan produces a reviewable plan and waits. Declining costs nothing.
- **Workers never collide.** Each task works in its own Git worktree with declared file ownership. Out-of-scope edits are reverted precisely — the rest of the work survives.
- **Costs are capped, twice.** Per-worker and whole-run dollar and token budgets stop runaway turns instead of surprising your invoice.
- **Green means green.** Results pass two verification levels (per-task and integrated) using allowlisted commands before anything lands.
- **Failure stays local.** A broken task doesn't sink independent ones; a crashed session resumes where it left off; orphaned workers get reclaimed.
- **Small tasks stay cheap.** Complexity gating routes simple requests to solo mode instead of paying for a capstan. Disagree? `--force`.

## Capstan vs. delegation tools

Pi's ecosystem has great *delegation* extensions — a parent agent asking child agents to think, review, or research. Capstan is for the other job: **many agents editing your repository in parallel, safely.**

| | Delegation-style subagents | Capstan |
|---|---|---|
| Best at | thinking, reviewing, answering | building — parallel repo edits |
| Isolation | shared workspace, varies | per-task Git worktrees, enforced |
| Cost | usually uncounted | hard budgets, live accounting |
| Landing | whatever the model did | verified, branch-first merge you control |

## Commands

```text
/capstan "task"                      start a capstan (add --force --max 4 --best-of 2 --plan-only as needed)
/capstan board                       live dashboard
/capstan pause | resume | abort      control the running capstan
/capstan replan                      add work mid-run
/capstan merge | clean | replay      land or clean up finished runs
/capstan pr [runId]                  push the integration branch and open a PR
/capstan cases                       browse/rate past runs (improves future planning)
/capstan config | validate | status  configure, lint config, inspect state
```

Programmatic delegation is a first-class citizen too: the main Pi model can call the `capstan_delegate` tool, and it goes through the same plan gate as everything else.

## Safety defaults (always on)

Branch-first landing (never auto-applies to your checkout) · plan confirmation gate · dollar + token budgets at worker and run level · scope-violation revert · two-level verification with a command prefix allowlist · worker extension isolation · credential redaction in logs and the case store · atomic state with recovery.

Git worktrees isolate concurrent work — they don't contain malicious code. Trust your repo and these defaults have you covered; don't trust it? Run Capstan inside a container.

## Documentation

- **[docs/README.md](./docs/README.md)** — start here: quick reference and patterns
- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** — all 51 configuration keys (when you outgrow the defaults)
- **[docs/DESIGN_PHILOSOPHY.md](./docs/DESIGN_PHILOSOPHY.md)** — why it's built this way
- **[docs/EXTENSION_POINTS.md](./docs/EXTENSION_POINTS.md)** · **[docs/PLUGINS.md](./docs/PLUGINS.md)** — guards and plugins
- **[docs/examples/](./docs/examples/)** — copy-paste configs and plugin examples

## Development

```bash
npm ci
npm run check        # types + syntax
npm test             # unit suite
npm run test:native  # real Pi RPC smoke
```

CI runs Linux + Windows on every push, with a daily cross-platform soak.

## Why "Capstan"

A capstan turns one person's pull into tons of controlled force — and its pawl means the load never slips back. Many hands (parallel workers), one winch (the orchestrator), total control (gates, budgets, plan confirmation, reversible merges).

## License

[MIT](./LICENSE)
