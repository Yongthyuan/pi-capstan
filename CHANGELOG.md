# Changelog

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
