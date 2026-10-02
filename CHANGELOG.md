# Changelog

## Unreleased

- Planner: mechanical acceptance-command repair (strip unsafe shell, fill from auto-detect), common JSON slip fixes, and clearer solo fallback when retries still fail.
- Verification: auto-detect with no commands is now fail-closed (`missingCommands`); only explicit `run.verify.*: []` skips a lane.
- Plugins: mailbox delivery invokes collaboration `coordinate()`; scheduling `adjust()` runs between waves with live metrics snapshots.
- DX: Node ≥22.19 preflight on npm scripts with an actionable strip-types message; `safetyGuardPath` expands `~/`.
- `/capstan pr`: always writes `pr-body.md`, pushes the branch, and degrades gracefully when `gh` is missing or PR create fails.

## 0.11.0 — Reviewable parallel delivery (2026-09-10)

- Delivery reports and PRs now distinguish recorded passes from skipped or missing verification. Final integration evidence is persisted; PR bodies include task checks, candidate/promotion SHAs, review requirements, and redacted fields.
- Planner calls abort at their wall-clock deadline. Disabled reasoning is omitted from the provider request; output exhaustion is classified separately instead of triggering the same JSON repair repeatedly.
- Worker models resolve against Pi at launch. Gate, planner, workers, and benchmark tooling use Pi model selection/authentication; explicit missing models fail without a provider fallback. Integration fixers are restricted to participating tasks' authorized paths and checked before commit.
- Serialized state writes, merges, user interactions, and setup operations share a tested queue primitive that continues after rejected work.
- Added a planning catalog, fixed smoke cases, source/config identities, and attempt-preserving metrics. Retries cannot mix models or source snapshots. Added a native Pi E2E that implements two modules from failing tests and records the integrated result.
- **Plugin API cleanup:** removed declared plugin hooks the runtime did not invoke. The supported surface and examples now match actual runtime calls; update custom TypeScript plugins using removed members.
- Rebuilt English/Chinese READMEs with feature-to-source links, workflow artwork, and a reproducible v0.10.0/v0.11.0 reporting comparison. Added `pi-package` discovery metadata and a Pi gallery image. Published raw development smoke artifacts with explicit limitations.
- Validation: local type/syntax checks; 80/80 tests (published v0.10.0: 61/61). The recorded two-worker DeepSeek E2E passed on the development core snapshot. Earlier planner smoke completed 4/10 cases; an OAuth follow-up was rejected for unsafe syntax. No general planning-quality improvement is claimed.
- UI remains mixed English/Chinese; the previously planned full i18n is not included. [Release evidence](./docs/evidence/v0.11.0/README.md).

## 0.10.0 — Functional identifier rename

- **Breaking:** renamed the command surface from `/swarm` to `/capstan` and the delegation tool from `swarm_delegate` to `capstan_delegate`.
- **Breaking:** renamed worker tools (`swarm_send`, `swarm_inbox`, `swarm_fs`), `PI_SWARM_*` environment variables, exported `Swarm*` TypeScript types, and generated Git branch/lock identifiers to their `capstan`/`PI_CAPSTAN_*` forms.
- Moved new configuration and run state to `capstan.json` and `.pi/capstan/runs`. Existing `swarm.json` configuration is still read as a fallback and its built-in worker tool names are migrated in memory, but existing `.pi/swarm/runs` are not migrated and will not appear in `/capstan resume`.
- Stabilized the pause and runtime-replan tests with an explicit fake-worker barrier instead of relying on a short overlap between worker states.
- First-run hardening: non-Git directories now fail fast with an actionable message right after solo-handoff gating (zero planner cost); model-auth errors point to `/model`; `/capstan` help rewritten as a quick-start card; config-save hints use absolute documentation URLs.
- UI locale remains mixed in this release (new user-facing messages are English-first, blocking errors carry a one-line Chinese fallback); full i18n with a `ui.language` key is planned for 0.11.

## 0.9.0 — Capstan rebrand

- Renamed the project to **Capstan** (formerly **pi-agent-swarm**). Intended package name: `pi-capstan`.
- Added keyword-rich package metadata (description + keywords) for npm/GitHub discoverability.
- No runtime behavior change. All functional identifiers remained unchanged: `/swarm` commands, `.pi/swarm.json`, `~/.pi/agent/extensions/swarm` auto-discovery path, and the `swarm_delegate` tool name.

## 0.8.0

- Aligned the verification contract between runtime behavior and documentation.

## 0.7.0

- Completed the agent-configurable swarm surface: documentation-first contract covering all 51 configuration leaf keys.
- Added `/swarm validate` configuration linting (`config-validator`) and `/swarm config` wizard polish.
- Plugin API documentation and copy-paste examples (`docs/PLUGINS.md`, `docs/examples/plugins/`).

## 0.6.0

- Opt-in `worker.strictBash`: bash denylist patterns blocking inline interpreter escapes (`python -c`, `node -e`, shell `-c`, `find -exec/-delete`).
- Daily cross-platform soak job in CI; scheduling and worktree-metadata test stabilization.
