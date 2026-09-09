# v0.11.0 evidence

This release separates a reproducible reporting comparison from provider-backed development smoke runs. These results do not establish general coding accuracy, speedups, or cost savings.

## Before / after: the same reporting fixture

Baseline: published `v0.10.0`, commit `4840524d189d825bf21880d32a8429344bee53c7`. Current: v0.11.0 reporter. Both receive [the same synthetic run](./report-fixture.json): two completed and merged workers, with all verification skipped. IDs, SHAs, durations, and zero cost in this fixture are synthetic.

| Output | v0.10.0 | v0.11.0 |
|---|---|---|
| Full report | [Before](./before-report.md) | [After](./after-report.md) |
| PR body | [Before](./before-pr.md) | [After](./after-pr.md) |

The old PR says `Merged verified subtasks` and `Result: complete`. The current PR says `complete; verification incomplete`, records skipped checks, and requires review. The comparison also verifies that [all recorded checks passing](./passed-report.md) still produces a success verdict, [a missing final check](./missing-final-report.md) does not, and a synthetic private path is redacted. Exact source and output hashes: [comparison.json](./comparison.json).

Reproduce from a full Git clone (the pinned baseline commit must be available):

```bash
npm ci
npm run evidence:compare
```

This calls the baseline reporter and PR template from the pinned source and the current reporter on one input. It makes no model/network requests. [Generator source](../../../scripts/generate-release-evidence.mjs).

## Test-suite comparison

The published v0.10.0 tag passes **61/61 tests**; v0.11.0 passes **80/80 tests** locally. Both local runs use Node v24.18.0 and Pi dependencies v0.84.1 on macOS. [Old test log](./tests-v0.10.0.txt) · [New test log](./tests-v0.11.0.txt) · [Type/syntax log](./check-v0.11.0.txt) · [Pi startup log](./native-startup-v0.11.0.txt). These are different suites; the count is neither coverage percentage nor a matched measure of defect reduction. The added tests cover reporting verdicts/redaction, model resolution, deadline behavior, benchmark aggregation, and serial-queue recovery. [Current tests](../../../test/) · [CI](https://github.com/Yongthyuan/pi-capstan/actions/workflows/ci.yml).

## Real model smoke runs

| Run | Recorded result | Source identity |
|---|---|---|
| [Two-module native Pi E2E](./native-e2e.json) | 2 workers; initially failing tests; integrated `npm test` passes; only two intended module files changed; 17 worker turns; 21,532 tokens; estimated $0.020755776 | `c52e00b60d0f…` |
| [Earlier planner smoke](./planner-smoke.json) | 10 cases / 8 unique prompts; 3 valid plans and 1 allowed solo result; completion 4/10; 6 JSON parse failures after repair; 0 recorded infrastructure failures; estimated $0.432961832 | `f8f81be4bc04…` |
| [OAuth targeted follow-up](./oauth-targeted.json) | 1 call, 32K output cap, 240-second deadline, no schema repair; 182.5 seconds; rejected unsafe command syntax; estimated $0.029403384 | `c52e00b60d0f…` |
| [Gate call](./gate-check.json) | Pi-authenticated classification succeeds with reasoning disabled; 118 input/output tokens | Development diagnostic; no source hash recorded in this artifact |

All four use `deepseek/deepseek-v4-flash`. Costs are Pi estimates, not settled invoices; interrupted calls can omit usage. The planner smoke predates the final deadline/diagnostic changes. Its `firstPassValidRate` did not yet count valid solo responses; the stated 4/10 uses `completionRate`. Do not present it as a full v0.11.0 quality score. The native E2E source snapshot predates the release version and presentation changes. Its temporary Git commit IDs describe the fixture repository, not commits in this project.

The OAuth follow-up returned a final response, but `docs_worker.acceptance.commands` contained disallowed shell syntax. The validator rejected the plan; those commands were not executed. Increasing the output allowance did not establish a planning-quality improvement.

The four model-run JSON files are unmodified copies of captured records. [Hashes and archive identities](./model-artifacts.json) · [Detailed Chinese validation](../../validation-2026-09-09.md). Source snapshots preserve the recorded inputs, including their original package metadata:

- [Planner snapshot archive](https://github.com/Yongthyuan/pi-capstan/releases/download/v0.11.0/source-f8f81be4bc04.tar.gz) · [Manifest](./source-f8f81be4bc04-manifest.json)
- [Native E2E snapshot archive](https://github.com/Yongthyuan/pi-capstan/releases/download/v0.11.0/source-c52e00b60d0f.tar.gz) · [Manifest](./source-c52e00b60d0f-manifest.json)

To run a new E2E from a configured Pi installation (incurs provider usage):

```bash
PI_CAPSTAN_TEST_MODEL=deepseek/deepseek-v4-flash npm run test:native:e2e
```

The 100-prompt catalog is a planning test catalog, not 100 completed coding tasks. No matched before/after model evaluation was completed for this release.
