# Capstan planner benchmark — 100 tasks

Measures planning and plan-validation quality over **100 distinct synthetic coding prompts**, across 6 generated fixtures (104 full cases).

## Pi model and authentication

The runner uses Pi's `ModelRuntime` and `ModelRegistry`, the same model/authentication layer used by `/capstan`. It has no vendor HTTP client and no separate credential store. It does not execute the generated plans. Use the native E2E test for worker execution and integrated verification.

Selection order: `--model provider/model`, `PI_CAPSTAN_TEST_MODEL`, then the default selected in Pi. There is no automatic provider fallback. Configure credentials in Pi with `/login`; choose a model with `/model`.

```bash
# Use the current Pi default
npm run bench

# Explicit official DeepSeek backend, using the same Pi credential
npm run bench -- --model deepseek/deepseek-v4-flash --budget-usd 1

# Full Pi /capstan path: plan, two real workers, candidate promotion, npm test
PI_CAPSTAN_TEST_MODEL=deepseek/deepseek-v4-flash npm run test:native:e2e

# Inspect the entire synthetic E2E input without a model call
PI_CAPSTAN_TEST_MODEL=deepseek/deepseek-v4-flash npm run test:native:e2e -- --dry-run
```

Provider-backed commands incur normal provider usage. The benchmark defaults to a $1 estimated budget and checks it before further calls; an in-flight response can cross that boundary. Pi catalog prices drive estimates, while provider billing is authoritative. Default per-call wall-clock deadline is 120 seconds, output limit is 16,000 tokens including reasoning, and JSON/schema repair uses the runtime default. `--budget-usd`, `--timeout-sec`, and `--max-output-tokens` override these limits. Output exhaustion stops the case instead of repeating the same insufficient limit as a JSON repair. No price or model is hardcoded into Capstan.

## Suites

| Suite | Cases | Command |
|---|---:|---|
| smoke | 10 | `npm run bench` |
| core | 36 | `npm run bench:core` |
| full | 104 | `npm run bench:full` |

```bash
# Offline catalog checks and selection
npm run bench:validate
npm run bench -- --dry-run
npm run bench:full -- --dry-run --limit 20

# Retry only error rows; preserve the original attempts
npm run bench:retry
```

Retries require the same model, source snapshot, catalog, and configuration. Legacy OpenRouter results remain archived, but cannot be overlaid into a new Pi-backed baseline. Start a fresh run after a model or code change. Transient errors, wrong solo/plan decisions, and golden-check failures remain distinct.

## Evidence and metrics

Each run saves its Git HEAD, dirty-source content hash, Pi/Node versions, model endpoint and price metadata, catalog/configuration hashes, final plans, and every attempt. Results are checkpointed after each attempt under ignored `results/`; `baseline-latest.json` points to the newest run. `finished`, `plannedCases`, and `processedCases` expose incomplete runs.

Returned model responses record their stop reason and usage. An aborted request may not return final provider usage, so its recorded cost can be incomplete; it must not be read as free execution.

- `completionRate`: final plan/solo outcomes divided by processed cases, including infrastructure failures.
- `plannedCompletionRate`: completed outcomes divided by all selected cases, including cases not reached before a stop.
- `eligibleCompletionRate` / `plannerQualityScore`: results excluding infrastructure failures; `qualityEligibleCases` gives the denominator.
- `infraFailRate`: rate limits, server errors, timeouts, authentication, unavailable models, and network failures.
- `firstAttemptCompletionRate`, `firstPassValidRate`, `schemaFirstFailRate`: original attempts, preserved when retry succeeds.
  A valid first response includes both a plan and a solo recommendation; whether that choice was appropriate is scored separately.
- `totalCost`, `totalTokens`, `medianWallMs`: include every recorded attempt. Duration sums call time and excludes inter-attempt waits.
- `goldenPassRate`, `soloRegretRate`, `soloMissRate`, and cross-tabs by category/fixture/difficulty/failure class.

Contract entity hits are a lexical diagnostic, not proof of semantic correctness. Golden checks measure declared plan structure; they do not establish that the resulting code works. A 100-task catalog is not a completed 100-task evaluation.

## Catalog layout

- `task-catalog.mjs`: 100 prompts, categories, difficulty, adversarial cases and golden expectations.
- `tasks.json`: exported snapshot (`npm run bench:export`).
- `fixtures-materialize.mjs`: fixed synthetic repositories; no user repository or historical case-store content is copied into prompts.
- `suites/smoke.lock.json`: exported smoke case IDs.
- `pi-client.mjs`: Pi model and authentication adapter.
- `metrics.ts`: case/attempt accounting and failure classification, covered by regression tests.

Default case spacing is 1 second (`BENCH_GAP_MS` overrides it). Each invocation uses a separate temporary fixture directory.
