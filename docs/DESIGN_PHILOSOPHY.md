# Pi-Swarm Design Philosophy

> Distilled from the architecture / product discussion that framed the
> “Agent-configurable Swarm” roadmap. This is the north star for what we build
> and what we refuse to build.

## One-line thesis

**Keep the runtime minimal and mature; make Claude (or any coding agent) the
configuration and extension interface via readable docs, schemas, and plugins.**

```
User → Agent (reads docs, understands capabilities, generates config/plugins)
         → Pi-Swarm (executes with native Pi + Git primitives)
         ↑______________ feedback (/swarm analyze, cases) ______________|
```

This mirrors Pi itself: `AGENTS.md`, skills, and extensions are all
**documentation-first surfaces** that agents read and act on—not opaque control
planes that only humans can operate through GUIs.

## What we are optimizing for

1. **Pi alignment** — Prefer Pi RPC, extensions, worktrees, and existing agent
   assets over new daemons, queues, or databases.
2. **Minimal core, rich surface** — Ship a small set of battle-tested primitives
   (gate → plan → DAG workers → verify → merge → report → cases). Expose them
   thoroughly so agents can customize behavior without forking the core.
3. **Agent as the smart UI** — Humans describe intent in natural language;
   agents translate intent into `swarm.json`, guards, and plugins by reading
   `docs/`.
4. **Declarative over hard-coded workflows** — Contrast with LangGraph / CrewAI /
   AutoGen-style “developer writes the graph in code.” Here the durable artifact
   is configuration + docs + optional plugins, not a bespoke Python workflow.
5. **Real isolation** — Git worktrees + process boundaries beat shared-memory
   multi-agent setups that pay constantly for conflict coordination.
6. **Fail safely and recover** — Branch-first merges, atomic state, resume,
   budgets that stop instead of silently overspending.

## What we are *not*

| Temptation | Why we avoid it |
|---|---|
| Becoming a general multi-agent framework | Scope explodes; Pi already is the agent runtime |
| Requiring Redis / Postgres / message buses | Breaks zero-external-service promise |
| Hiding capability behind undocumented knobs | Agents cannot customize what they cannot read |
| Shipping every advanced idea as core | Prefer plugin interfaces + examples |

## Comparison frame

### Versus mainstream multi-agent stacks

Most mature frameworks (LangGraph, CrewAI, AutoGen, MetaGPT, …) treat the LLM
as a **node inside a developer-authored workflow**. Strengths: production
orchestration patterns, schemas, checkpoints. Cost: shared state coordination,
heavy infra, and customization that usually means writing more framework code.

Pi-swarm’s bet is different:

- Isolation and history come from **Git**, not a checkpoint store.
- Scheduling is an explicit **DAG + path ownership**, not prompt-only roles.
- Customization is **docs → config/plugins**, so an agent session can reshape
  behavior without a release cycle.

Neither is universally “better.” If you need cluster-scale graph serving,
LangGraph-class systems win. If you want a Pi-native coding swarm that an agent
can reconfigure mid-conversation, this design wins.

### Versus other Pi multi-agent patterns

Pi already supports subagents / RPC workers. Pi-swarm is not “more agents for
their own sake.” It adds:

- complexity gating (simple tasks bounce back to the main session)
- plan review before spend
- worktree isolation + merge/verify gates
- budgets, resume, cases, and (increasingly) agent-readable extension points

Stay compatible with Pi’s construction ideas: keep core mechanics boring and
documented; let agents compose them.

## Capability layers (how the philosophy is delivered)

| Layer | Role | Agent interaction |
|---|---|---|
| **Docs** | Contract of the system | Read `docs/FOR_CLAUDE.md`, `CONFIGURATION.md`, `EXTENSION_POINTS.md`, `PLUGINS.md` |
| **Config** | Declarative behavior | Generate / edit `.pi/swarm.json`; validate with `/swarm validate` |
| **Wizard + templates** | Fast path to sane presets | `/swarm config` wizard; copy `docs/examples/configs/*` |
| **Guards** | Per-worker tools & policy | Custom extensions via `safetyGuardPath` |
| **Plugins** | Replace verification / scheduling / collaboration strategies | Paths in `run.*Strategy` fields |
| **Observability** | Close the feedback loop | `/swarm analyze` → config recommendations |
| **Cases** | Implicit learning | Past plans influence future planning |

## Feasibility verdict (from the original discussion)

The vision is **feasible and strategically aligned with Pi**:

- Agents are already good at reading technical docs and emitting JSON / TypeScript.
- The runtime already exposes a large config surface and custom guards.
- Remaining work is mainly **making extension points real and documented**, not
  inventing a new architecture.

Priority order that follows from the philosophy:

1. **Readable docs + examples** (agents cannot use what they cannot discover)
2. **Config assist** (wizard, templates, validate/autofix)
3. **Plugin interfaces wired into the runtime** (verification first)
4. **Analyze / recommend** (agents improve configs from history)
5. Only then: heavier core refactors (orchestrator split, hierarchical swarms, …)

## Design tests (use before adding features)

Ask of every proposed change:

1. Can an agent discover this from `docs/` without reading the source?
2. Does it stay zero-external-service and Pi-native?
3. Is it a **config/plugin/doc** change rather than a core special case?
4. Does it preserve worktree isolation, budgets, and recoverable state?
5. If removed, does the minimal path (plan → workers → merge) still work?

If a feature fails these tests, it probably belongs in an example plugin—or not
in the project.

## Related docs

- [FOR_CLAUDE.md](./FOR_CLAUDE.md) — operational playbook for agents
- [CONFIGURATION.md](./CONFIGURATION.md) — full config reference
- [EXTENSION_POINTS.md](./EXTENSION_POINTS.md) — guards and extension patterns
- [PLUGINS.md](./PLUGINS.md) — plugin API
- [examples/](./examples/) — copy-paste configs and plugin examples
