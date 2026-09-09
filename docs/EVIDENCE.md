# Capstan Evidence Surface

How to read a delivery report and Proof-Carrying PR. Here, “proof” means recorded runtime evidence: commands, exit codes, and commit identities, not formal verification or a guarantee of correctness.

For a reproducible old/new comparison and recorded model runs, see [v0.11.0 evidence](./evidence/v0.11.0/README.md).

## Verdict first

The report opens with a one-line conclusion:

- **完整成功 — 所列检查通过，建议合入前审查** — all tasks were promoted with recorded task, candidate, and final checks; code review is still needed
- **执行完成 — 验证证据不完整，需人工复核** — execution ended, but one or more lanes were skipped, missing, or unsuccessful
- **部分完成 — 需人工复核后再合入** — tasks remain unlanded
- **未完成 — 不要合入整个 run** — aborted / failed; any previously promoted work must be reviewed separately

The final integration check is persisted in run state. Old runs without this field are marked unknown; a successful process phase cannot substitute for missing verification evidence.

## Transaction log

Each candidate operation shows:

1. base SHA → candidate SHA
2. which worker tasks merged into the candidate
3. allowlisted verification commands and exit codes
4. promotion to last-green, or discard

`last-green` only moves forward on successful promotion. Discard never rewrites the integration branch.

## Per-task evidence

For each worker: goal, status, retries, cost, verification commands + exit codes, and any scope-revert paths.

## Proof-Carrying PR

`/capstan pr` pushes the integration branch and opens a GitHub PR whose body includes transaction SHAs, task evidence, and the final verification result. Every rendered field is scrubbed for local paths and common credential patterns, including model-authored goals and command arguments. Raw RPC logs and command output are excluded. Review the generated PR as usual; redacted command paths need local substitution when rechecking.

Re-check locally:

```bash
git range-diff <base-sha>...HEAD
```

## Static sample

See [examples/proof-carrying-delivery.md](./examples/proof-carrying-delivery.md) for a sample you can read without installing Pi.
