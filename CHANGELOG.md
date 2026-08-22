# Changelog

## 0.9.0 — Capstan rebrand

- Renamed the project to **Capstan** (formerly **pi-agent-swarm**). Intended package name: `pi-capstan`.
- Added keyword-rich package metadata (description + keywords) for npm/GitHub discoverability.
- No runtime behavior change. All functional identifiers are intentionally unchanged: `/swarm` commands, `.pi/swarm.json`, `~/.pi/agent/extensions/swarm` auto-discovery path, and the `swarm_delegate` tool name.

## 0.8.0

- Aligned the verification contract between runtime behavior and documentation.

## 0.7.0

- Completed the agent-configurable swarm surface: documentation-first contract covering all 51 configuration leaf keys.
- Added `/swarm validate` configuration linting (`config-validator`) and `/swarm config` wizard polish.
- Plugin API documentation and copy-paste examples (`docs/PLUGINS.md`, `docs/examples/plugins/`).

## 0.6.0

- Opt-in `worker.strictBash`: bash denylist patterns blocking inline interpreter escapes (`python -c`, `node -e`, shell `-c`, `find -exec/-delete`).
- Daily cross-platform soak job in CI; scheduling and worktree-metadata test stabilization.
