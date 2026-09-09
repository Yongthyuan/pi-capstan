# Sample Proof-Carrying Delivery (static)

> This is an **illustrative example**, not a real run or benchmark result.
> IDs, commits, timings, and costs below are invented to explain the output.
> Real runs use the model and authentication configured in Pi.

## Capstan Proof-Carrying Delivery

**Run** `run_demo` · complete; checks passed · $0.6300 · 1m35s

This PR contains the promoted integration branch. Verification evidence is recorded below; skipped or missing checks are not a verified pass.
Verdict: 完整成功 — 所列检查通过，建议合入前审查

### Transaction log

- ✔ **wave** `op1` · `promoted`
  - base → candidate: `7be104a` → `a3f9c2b`
  - merged into candidate: worker-db, worker-api
  - verification: passed / 通过 · `./node_modules/.bin/tsc --noEmit` exit 0 (8.2s)
  - promoted → `e91d33c` (last-green)

### Per-task evidence

- **worker-db** — db
  - status: done · retries: 1 · cost: $0.4100
  - goal: add sessions table
  - verification: passed / 通过 · `npm test` (exit 0)
  - landed: yes
  - scope revert: README.md
- **worker-api** — api
  - status: done · retries: 0 · cost: $0.2200
  - goal: add login route
  - verification: passed / 通过 · `./node_modules/.bin/tsc --noEmit` (exit 0)
  - landed: yes

### Final integration verification

- passed / 通过
- `npm test` (exit 0)

If a task check, promoted candidate check, or final integration check is skipped or missing, the verdict instead requires manual review. Older runs without persisted final verification remain unknown.

### How to re-check

```bash
git range-diff 7be104a...HEAD
```

_Local RPC logs, sessions, and full reports were not uploaded by `/capstan pr`._

---

## Matching delivery report (excerpt)

```text
# Capstan 交付报告 · OAuth login

**结论**: 完整成功 — 所列检查通过，建议合入前审查
- 用时: 1m35s · 成本: $0.6300

## 事务日志
- ✔ wave `op1` · promoted · worker-db, worker-api → e91d33c

## 每任务验收
| id | 状态 | 验证 | 成本 | 越界回滚 |
| worker-db | done | ✔ npm test→0 | $0.41 | 1 |
| worker-api | done | ✔ tsc→0 | $0.22 | 0 |

## 最终验证
- ✔ npm test · exit 0 · 3.0s
```
