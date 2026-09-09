# Discovery and presentation, v0.11.0

The positioning is **multi-agent coding for Pi**, with a concrete delivery story: approve a plan, run parallel Git worktrees, then review commit and verification evidence. These terms describe implemented behavior; they are not a measured list of trending search queries.

## Keyword map

| User intent | Terms used | Backing feature | Placement |
|---|---|---|---|
| Find a Pi coding extension | `pi-package`, `pi-coding-agent`, `pi-extension` | Pi extension entry point, shared model/auth | npm metadata, title, gallery image |
| Run coding agents in parallel | `multi-agent`, `coding-agent`, `parallel-agents`, `subagents` | Orchestrator, worker pool, task DAG | README lead, npm keywords, GitHub topics |
| Isolate repository changes | `git-worktree`, `agent-orchestration` | Worktree creation, file ownership, candidate branches | Feature table and workflow diagram |
| Retain approval and review | `human-in-the-loop`, `verification`, `pull-request` | Plan gate and evidence-carrying PR body | Before/after comparison and evidence links |
| Explore agent workflows | `agentic-workflows`, `developer-tools`, `typescript` | Configurable orchestration and plugin surface | npm keywords and GitHub topics |
| Use a configured model | `llm`, `deepseek` | Pi-native model policy; one recorded DeepSeek smoke | npm keywords and validation evidence |

Generic ecosystem terms help people recognize the category. **Verification evidence in the PR** supplies the more specific reason to inspect Capstan. “Proof-Carrying PR” is explained as recorded runtime evidence, not formal proof. No competitor speed, reliability, or cost advantage is asserted.

## Concrete before / after

| Surface | Before | v0.11.0 |
|---|---|---|
| Pi directory eligibility | Missing `pi-package` npm keyword | Keyword added, plus tagged PNG gallery image |
| Project identity | Capstan name and metaphor before category | Multi-agent coding for Pi in the title and opening |
| Feature presentation | Broad safety claims and a generic competitor table | Workflow image and feature links to implementation/tests |
| Change evidence | No paired release example | Same-input old/new report and PR body, controls, hashes, reproduction |
| npm and GitHub metadata | General swarm topics; no GitHub homepage | Intent-mapped terms and a direct npm installation destination |

[Exact metadata snapshots](./evidence/v0.11.0/discovery-metadata.json) retain both versions. The source artifacts make the comparison reviewable; search ranking and adoption still need observation after release.

## Sources and design references

Reviewed 2026-09-10. Pi's official [package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) describes the `pi-package` keyword for its [package directory](https://pi.dev/packages) and optional PNG/JPEG/GIF/WebP image metadata. This is a directory eligibility fix; publication does not guarantee immediate indexing.

npm documents [`description` and `keywords`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) as package discovery fields. GitHub documents [repository topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) and [README presentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes). Topics are limited to 20 relevant terms.

Primary ecosystem examples reviewed for category vocabulary and feature organization: [pi-orchestration](https://github.com/stew675/pi-orchestration), [pi-worktrees](https://github.com/harms-haus/pi-worktrees), [pi-dynamic-workflow](https://github.com/milanglacier/pi-dynamic-workflow), [pi-subagent-tasks](https://github.com/harms-haus/pi-subagent-tasks), and [pi-herd](https://github.com/ribbons-digital/pi-herd). These are presentation references, not benchmarked competitors. Their existence does not establish feature exclusivity for Capstan.

## How to assess the result

After publication, verify the npm version, rendered README/images, GitHub topics, and Pi directory entry. Record available GitHub traffic/referrers and npm downloads over comparable windows, distinguishing release publicity and automated downloads. Query visibility manually for the intended category terms. Report observations with dates; do not attribute a change causally to keywords without stronger evidence.
