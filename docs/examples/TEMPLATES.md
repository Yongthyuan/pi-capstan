# Configuration Templates Guide

This document explains how to use and customize pre-built swarm configuration templates.

## Quick Start

### 1. Using the Interactive Wizard

The fastest way to generate a project-specific configuration:

```bash
/swarm config
# Choose "Yes" when prompted to use the wizard
# Answer 4 questions about your use case
# Review and save the generated configuration
```

### 2. Using Pre-built Templates

Copy and customize one of the templates in `docs/examples/configs/`:

```bash
# Copy template to your project
cp docs/examples/configs/high-quality-production.json .pi/swarm.json

# Edit to match your project
nano .pi/swarm.json
```

## Available Templates

### High-Throughput Refactor

**File:** `high-throughput-refactor.json`

**Best for:**
- Large-scale refactoring (50+ files)
- Architectural migrations
- Codebase-wide pattern changes
- Dependency upgrades across many modules

**Key features:**
- Up to 12 subtasks, 8 concurrent workers
- $40 total budget, $3 per worker
- Branch-only merge (never auto-applies)
- Continue on independent failures

**When to use:**
- Renaming APIs across the entire codebase
- Migrating from one framework to another
- Splitting monoliths into modules
- Updating deprecated patterns globally

**Cost estimate:** $12-36 per run

---

### High-Quality Production

**File:** `high-quality-production.json`

**Best for:**
- Critical production features
- Security-sensitive code
- Public APIs
- Payment/auth flows

**Key features:**
- Best-of-3 candidate competition (3x cost)
- LLM judge selects winner
- $60 total budget, $5 per worker
- 3 retries on failure
- Comprehensive verification

**When to use:**
- Implementing OAuth/SSO
- Building checkout flows
- Creating admin dashboards
- Adding audit logging

**Cost estimate:** $18-54 per run (3x normal due to best-of-3)

---

### Untrusted Repository

**File:** `untrusted-repository.json`

**Best for:**
- Unknown/untrusted codebases
- Open-source contributions
- Learning new projects
- Low-trust environments

**Key features:**
- Strict bash mode (blocks `eval`, `source`, interpreter escapes)
- Limited tool access (no `bash_tool`, only read/edit/write)
- Scope violation = immediate failure
- Auto-deny all approval requests
- $10 budget cap

**When to use:**
- First time working on a project
- Contributing to unfamiliar repos
- Security-conscious environments
- Sandboxed exploration

**Cost estimate:** $3-10 per run

---

### Fast Iteration / PoC

**File:** `fast-iteration-low-cost.json`

**Best for:**
- Prototyping
- Learning experiments
- Proof-of-concept builds
- Quick iterations

**Key features:**
- Max 4 subtasks, 2 concurrent workers
- $5 total budget, $1 per worker
- Single candidate (no best-of-N)
- 1 retry only
- Minimal verification

**When to use:**
- "Does this approach work?"
- Building throwaway prototypes
- Testing swarm on small tasks
- Budget-conscious exploration

**Cost estimate:** $1.5-4.5 per run

## Customization Guide

### Adjusting for Your Project

All templates assume standard Node.js verification commands. Update these based on your project:

```json
{
  "run": {
    "verify": {
      "worker": null,  // or ["npm test"] for per-worker verification
      "integrationLight": ["npm run typecheck"],  // fast checks
      "full": ["npm test", "npm run typecheck", "npm run lint"]  // comprehensive
    }
  }
}
```

**Common verification commands:**

| Project Type | Commands |
|--------------|----------|
| TypeScript + Jest | `["npm test", "npm run typecheck"]` |
| Python | `["pytest", "mypy ."]` |
| Go | `["go test ./...", "go vet ./..."]` |
| Rust | `["cargo test", "cargo clippy"]` |
| Ruby | `["bundle exec rspec", "bundle exec rubocop"]` |

### Adjusting Budget

Budget = number of subtasks × worker cost × retries × best-of-N

**Example calculations:**

```
Fast iteration:
4 tasks × $1 × 1 retry × 1 candidate = $4 minimum

Production feature:
8 tasks × $5 × 3 retries × 3 candidates = $360 maximum (rare)
8 tasks × $5 × 1 retry × 3 candidates = $120 typical
```

**Budget recommendations by task size:**

| Task Size | Suggested Budget |
|-----------|------------------|
| Small (1-3 files) | $5-10 |
| Medium (4-10 files) | $10-30 |
| Large (11-50 files) | $30-80 |
| Very large (50+ files) | $80-200 |

### Adjusting Concurrency

Higher concurrency = faster but more conflicts:

```json
{
  "worker": {
    "maxConcurrency": 2  // conservative, fewer conflicts
    // maxConcurrency: 4  // balanced
    // maxConcurrency: 8  // aggressive, faster but more merge work
  }
}
```

**Guidelines:**
- 2 concurrent = safe for projects with tight coupling
- 4 concurrent = balanced default
- 8 concurrent = only for highly modular codebases

### Adjusting Quality

**Fast mode** (single candidate, 1 retry):
```json
{
  "worker": {
    "bestOfN": 1,
    "maxRetries": 1
  }
}
```

**Balanced mode** (single candidate, 2-3 retries):
```json
{
  "worker": {
    "bestOfN": 1,
    "maxRetries": 2
  }
}
```

**High quality mode** (best-of-3, 3 retries):
```json
{
  "worker": {
    "bestOfN": 3,
    "bestOfNJudge": true,  // use LLM judge
    "maxRetries": 3
  }
}
```

## Template Combinations

You can mix features from multiple templates:

### Example: High-Quality Refactor

```json
{
  "planner": {
    "maxSubtasks": 12,  // from high-throughput-refactor
    "budgetUsd": 3
  },
  "worker": {
    "maxConcurrency": 6,
    "bestOfN": 2,  // from high-quality-production (reduced)
    "maxRetries": 3,
    "perAgentBudgetUsd": 4
  },
  "run": {
    "budgetUsd": 80,
    "mergeStrategy": "branch",
    "verify": {
      "worker": null,
      "integrationLight": ["npm run typecheck"],
      "full": ["npm test", "npm run typecheck"]
    }
  }
}
```

### Example: Safe Fast Iteration

```json
{
  "planner": {
    "maxSubtasks": 4,  // from fast-iteration
    "budgetUsd": 0.5
  },
  "worker": {
    "maxConcurrency": 2,
    "strictBash": true,  // from untrusted-repository
    "scopeViolationPolicy": "fail",
    "perAgentBudgetUsd": 1.5
  },
  "run": {
    "budgetUsd": 8,
    "mergeStrategy": "branch"
  }
}
```

## Testing Your Configuration

After customizing a template:

1. **Validate syntax:**
   ```bash
   node -e "console.log(JSON.parse(require('fs').readFileSync('.pi/swarm.json')))"
   ```

2. **Test with small task:**
   ```bash
   /swarm "add a simple helper function" --budget 2
   ```

3. **Check cost:**
   ```bash
   /swarm status
   # Review "totals.cost" in the output
   ```

4. **Adjust based on results:**
   - Cost too high? Lower `perAgentBudgetUsd` or `maxSubtasks`
   - Too many conflicts? Lower `maxConcurrency`
   - Quality issues? Enable `bestOfN: 2` or add worker verification

## Next Steps

- Read [CONFIGURATION.md](../CONFIGURATION.md) for all 51 configuration leaf keys
- Read [FOR_CLAUDE.md](../FOR_CLAUDE.md) if you are Claude generating configs
- Explore [extension examples](./extensions/) for custom tools and strategies
