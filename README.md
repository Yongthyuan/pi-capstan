# Pi Agent Swarm

[中文文档](./README.zh-CN.md)

Pi Agent Swarm is a native multi-agent extension for [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). A single `/swarm <task>` command takes a complex task through complexity gating, evidence-based decomposition, plan confirmation, parallel execution in Git worktrees, verification, merging, recovery, and report injection.

Current version: `0.6.0`. Positioning: a controlled beta for your own trusted repositories, not a security sandbox for untrusted code. Tested against Pi 0.84.1; required API capabilities are probed at load time. Pi `>=0.84.1` is accepted: 0.84.x loads as compatible, and newer releases load with an explicit warning instead of refusing to start.

## What it does

- Two-tier complexity gating with `--force` / `--solo` / `--plan-only`
- Hybrid planner scout that reads tracked/untracked files, manifests, symbol/test structure, import neighborhoods, and test/source adjacency
- Strict SwarmPlan validation: DAG, topological mergeOrder, contracts, and path ownership
- Native `pi --mode rpc` workers with JSONL transport, usage accounting, steer/abort, and batched UI approval forwarding
- Worker extension isolation: `--no-extensions` plus explicit safety and scope guards
- Repo-level cross-process lease, PID launch-identity check, heartbeat-based orphan worker reclaim, and idempotent `/swarm resume`
- Git worktrees, shared dependency directories with trusted setup, temporary dirty baselines, last-green candidate merging, conflict arbitration, and an integration fixer
- Slot pipeline scheduling with dependency-aware partial success; a failed task does not swallow independent green results
- Precise rollback on scope violations by default; explicit channels for lockfile/shared/generated paths
- Worker mailbox, lead coordination requests, mid-run `/swarm replan`, and scoped `swarm_fs`
- Optional `--best-of N` same-task candidate competition; a read-only reviewer picks before the candidate enters the verification track
- Two-level verification (worker and integration); verification commands run with `shell:false`, a syntax gate, and a prefix allowlist
- Unified control barrier for pause, persistent budgets, single-worker detach, and kill; active tools do not count toward stall, and true silence gets one steer before failing
- Dashboard, widget, report renderer, run entries, case store, and log replay
- Default `branch` landing; `apply` is only allowed on a clean, non-drifted main worktree

## Install

Load directly during development:

```bash
npm ci
pi --no-extensions -e /absolute/path/to/pi-swarm/index.ts
```

User-level auto-discovery:

```bash
ln -s /absolute/path/to/pi-swarm ~/.pi/agent/extensions/swarm
```

Then run `/reload` inside Pi, or restart Pi. Copying the whole directory also works; the extension entry point is `index.ts`.

## Usage

```text
/swarm "implement the OAuth backend, the login page, tests, and docs"
/swarm "task" --force --max 4 --budget 8 --model provider/model
/swarm "high-risk task" --force --best-of 2
/swarm "task" --plan-only
/swarm board
/swarm pause | resume [runId] | abort
/swarm replan
/swarm merge [runId] | clean | replay <runId>
/swarm pr [runId]
/swarm cases [rate <id> +1|-1 | delete <id>]
/swarm config | status
```

The main Pi model can also call the `swarm_delegate` tool, but it cannot bypass human plan confirmation.

`/swarm pr [runId]` asks for confirmation again, then pushes only the last-green integration branch and creates a PR through the GitHub CLI; local RPC logs, sessions, and report bodies never end up in the PR. Remote CI is still governed by the target repository's own rules.

## Documentation

**For Claude and developers**: Comprehensive documentation is available in the [`docs/`](./docs/) directory:

- **[docs/README.md](./docs/README.md)** - Start here: quick reference, common patterns, and how Claude should use swarm
- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** - Complete reference for all 89 configuration options with examples
- **[docs/EXTENSION_POINTS.md](./docs/EXTENSION_POINTS.md)** - Guide for extending swarm with custom tools, strategies, and templates

These docs enable Claude to read, understand, and customize swarm behavior by generating appropriate configurations and extensions based on project needs.

## Configuration

Merge order: built-in defaults → `~/.pi/agent/swarm.json` → `<repo>/.pi/swarm.json` → command-line flags.

See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for complete details and common configuration patterns.

Safety defaults:

- `mergeStrategy: "branch"`
- `caseStore.enabled: true`; writes only to the user's local agent directory and redacts common credentials
- `failurePolicy: "continue-independent"`
- `worker.shareDependencyDirs: ["node_modules"]`; symlinks on POSIX, junctions on Windows
- `worker.setupCommands: []`; runs only in trusted projects, constrained by a separate allowlist and timeout
- `worker.scopeViolationPolicy: "revert"`; out-of-scope paths do not consume the whole task result
- `worker.strictBash: false`; opting in appends denylist patterns that block inline interpreter code (`python -c`, `node -e`, shell `-c`, `find -exec/-delete`) at the cost of also blocking some legitimate one-liners
- Default budgets: planner `$1/160K tokens`, worker `$2/250K`, run `$8/1M`
- Workers load only the explicitly listed tool and guard extensions
- The planner can only pick verification commands from `run.verifyAllowedPrefixes`; pipes, redirects, command substitution, and multi-line commands are rejected
- Planner and workers all have call timeouts plus token and dollar budgets; planner usage counts toward the run total
- A budget overrun first interrupts the current model turn, then lets the user choose between raising the budget and stopping the run
- `--best-of N` increases model cost linearly; the default stays `1`
- Results from a dirty baseline are never auto-applied
- RPC logs strip prompts, command bodies, and common credentials by default; logs/sessions are retained for 14/30 days respectively
- State uses atomic writes with a `state.prev.json` fallback; corrupted state raises an explicit warning at session start

Run `/swarm config` inside Pi to write a project config.

## Testing

```bash
npm install
npm run check
npm test
npm run test:native
npm run test:soak [iterations] [name-pattern]
```

`test:native` uses a temporary `PI_CODING_AGENT_DIR` to simulate `~/.pi/agent/extensions/swarm/` auto-discovery and verifies `/swarm` registration, the guard, mailbox/safe file tool loading, and command handling over the Pi RPC protocol; it never touches the real `~/.pi`. `test:soak` repeats the suite to surface timing flakes that a single green run hides. CI runs a Linux and Windows matrix on every push and a daily cross-platform soak.

Optional canaries against a real, already-authenticated model:

```bash
PI_SWARM_TEST_MODEL=provider/model npm run test:native:plan
PI_SWARM_TEST_MODEL=provider/model npm run test:native:model
PI_SWARM_TEST_MODEL=provider/model npm run test:native:e2e
```

The first two verify the real planner and a real worker; `test:native:e2e` drives the native `/swarm` command through plan confirmation, two real workers, candidate verification, integration advancement, and report status. The tests clean up their temporary repositories, but Pi may refresh its own short-lived auth lock files.

## Safety boundary

Git worktrees provide concurrency isolation, not an OS security sandbox. The scope guard, bash denylist, extension isolation, safe verification executor, and pre-merge diff checks are there to prevent accidents, but your project's own test scripts still execute code. For malicious repositories, scripts, or prompts you must use a separate container or OS sandbox with isolated network and credentials.

## License

[MIT](./LICENSE)
