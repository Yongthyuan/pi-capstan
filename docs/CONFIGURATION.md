# Pi-Swarm Configuration Reference

> **For Claude**: This document describes all configuration options for pi-swarm. You can read this to understand how to customize swarm behavior for specific projects or tasks.

## Configuration Hierarchy

Configurations merge in this order (later overrides earlier):
1. Built-in defaults (see below)
2. Global: `~/.pi/agent/swarm.json`
3. Project: `<repo>/.pi/swarm.json`
4. Command flags: `--max`, `--budget`, `--model`, `--best-of`

## Complete Configuration Schema

### Gate (Complexity Detection)

Controls when a task triggers multi-agent swarm vs single-agent passthrough.

```json
{
  "gate": {
    "model": null,              // Model for gate decision (null = use session model)
    "ruleThresholdLow": 0,      // Score ≤ this → simple (passthrough)
    "ruleThresholdHigh": 5      // Score ≥ this → complex (swarm)
                                // Between low and high → consult model
  }
}
```

**Rule scoring factors**:
- Explicit parallelism keywords: +2 each ("parallel", "concurrent", "independent")
- Multiple deliverables: +1 per conjunction ("and", ",")
- Architectural keywords: +2 ("refactor", "migrate", "redesign")
- Scope indicators: +1 per ("entire", "all", "every")

**When to adjust**:
- Lower threshold → more tasks use swarm (higher cost, potentially better quality)
- Raise threshold → fewer swarm invocations (lower cost, simpler tasks handled solo)

### Planner

Controls task decomposition and plan generation.

```json
{
  "planner": {
    "model": null,              // Model for planning (null = session model)
    "maxSubtasks": 6,           // Max parallel subtasks (2-12)
    "repoMapTokens": 4500,      // Tokens for repository context (500-50000)
    "schemaRetries": 2,         // JSON schema validation retries (0-5)
    "timeoutSec": 120,          // Planning timeout (10-900)
    "budgetUsd": 1,             // Max planning cost ($)
    "tokenLimit": 160000        // Max planning tokens
  }
}
```

**When to adjust**:
- `maxSubtasks`: Increase for large refactors (up to 12), decrease for focused changes
- `repoMapTokens`: Increase for large codebases or when planner lacks context
- `budgetUsd`: Increase if planning times out on complex tasks

### Worker

Controls individual worker behavior and resource limits.

```json
{
  "worker": {
    "model": null,              // Worker model (null = session model)
    "maxConcurrency": 4,        // Max parallel workers (1-8)
    "maxRetries": 2,            // Retries per worker on failure (0-5)
    "stallSec": 180,            // Seconds before stall detection triggers (10-3600)
    "wallClockMin": 25,         // Max wall-clock time per worker (1-240)
    "perAgentBudgetUsd": 2,     // Budget per worker ($)
    "perAgentTokenLimit": 250000, // Token limit per worker
    
    "tools": [                  // Tools available to workers
      "read", "bash", "edit", "write", "grep", "find", "ls",
      "swarm_send",             // Send message to peer worker
      "swarm_inbox",            // Read inbox from peers
      "swarm_fs"                // Scoped filesystem ops (mkdir/touch/remove/move/copy)
    ],
    
    "setupCommands": [],        // Commands run before each worker starts
                                // Example: ["npm install --legacy-peer-deps"]
    "setupTimeoutSec": 300,     // Setup timeout (10-3600)
    
    "shareDependencyDirs": [    // Dirs shared via symlink (POSIX) or junction (Windows)
      "node_modules"            // Avoids re-installing dependencies per worktree
    ],
    
    "scopeAllowlist": [         // Files allowed outside ownedPaths (lockfiles, etc)
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Cargo.lock",
      "poetry.lock",
      "uv.lock"
    ],
    
    "scopeViolationPolicy": "revert",  // "revert" or "fail"
                                       // revert = remove violating files, continue
                                       // fail = abort worker immediately
    
    "strictBash": false,        // Enable strict interpreter escape blocking
                                // Blocks: python -c, node -e, sh -c, find -exec
                                // Trade-off: also blocks legitimate one-liners
    
    "bestOfN": 1,               // Run N candidates, pick best (1-8)
    "bestOfNJudge": true        // Use reviewer agent to pick winner (vs first success)
  }
}
```

**When to adjust**:
- `maxConcurrency`: Match to your system resources (4 is conservative, 8 for powerful machines)
- `tools`: Remove tools for security (e.g., remove "bash" for untrusted repos)
- `setupCommands`: Add project-specific setup (e.g., build steps, environment prep)
- `strictBash`: Enable for untrusted code or when workers shouldn't spawn subprocesses
- `bestOfN`: Use 2-3 for critical tasks where quality > cost

### Run

Controls overall run execution and verification.

```json
{
  "run": {
    "budgetUsd": 8,             // Total run budget ($)
    "tokenLimit": 1000000,      // Total run token limit
    
    "mergeStrategy": "branch",  // "branch" | "apply" | "commit"
                                // branch = push to new branch, never touch main
                                // apply = apply to clean main worktree (危险!)
                                // commit = commit to current branch
    
    "verify": {                 // Verification commands at each stage
      "worker": null,           // After each worker (null = skip)
      "integrationLight": null, // After each merge (null = skip)
      "full": null              // Final verification (null = skip)
                                // Example: ["npm test", "npm run typecheck"]
    },
    
    "verifyTimeoutSec": 300,    // Verification timeout (10-3600)
    
    "verifyAllowedPrefixes": [  // Only these command prefixes allowed in verify
      "npm test", "npm run", "npm exec --no --",
      "pnpm test", "pnpm run", "pnpm exec",
      "yarn test", "yarn run", "yarn exec",
      "bun test", "bun run",
      "python -m pytest", "python3 -m pytest", "pytest",
      "cargo test", "cargo check", "cargo build", "cargo clippy",
      "go test", "go build", "go vet",
      "./gradlew test", "./gradlew check", "./gradlew build",
      "mvn test", "mvn verify",
      "dotnet test", "dotnet build",
      "./node_modules/.bin/tsc"
    ],
    
    "setupAllowedPrefixes": [   // Only these prefixes allowed in setupCommands
      "npm ci", "npm install",
      "pnpm install",
      "yarn install",
      "bun install",
      "python -m pip install", "python3 -m pip install",
      "uv sync",
      "cargo fetch"
    ],
    
    "failurePolicy": "continue-independent"  // "fail-fast" | "continue-independent"
                                             // fail-fast = abort all on first failure
                                             // continue-independent = keep running independent tasks
  }
}
```

**When to adjust**:
- `verify`: Add test commands for continuous validation
- `mergeStrategy`: Use "branch" (safe default), only use "apply" on clean repos you trust
- `failurePolicy`: Use "fail-fast" when failures cascade, "continue-independent" for partial success

### Approval Policy

Controls how worker UI requests (confirmations, inputs) are handled.

```json
{
  "approvalPolicy": "route"   // "route" | "autoDeny" | "autoAllow"
                              // route = forward to user
                              // autoDeny = auto-deny all (safest for unattended)
                              // autoAllow = auto-allow all (危险!)
}
```

### Bash Denylist

Regex patterns blocking dangerous shell commands.

```json
{
  "bashDenylist": [
    "\\bgit\\b[^\\n]*(?:\\s)(?:add|commit|push|rebase|reset|...)",  // Block git mutations
    "\\bsudo\\b",                                                     // Block sudo
    "\\brm\\b[^\\n]*\\s-rf\\s+[/~]",                                 // Block rm -rf / or ~
    "\\b(?:curl|wget)\\b[^|\\n]*\\|\\s*(?:sh|bash|zsh)\\b",         // Block curl | sh
    "(?:^|[;&|]\\s*)(?:rm|mv|cp|touch|mkdir|install|ln|...)",       // Block file mutations
    "\\b(?:sed\\s+-[^\\n]*i|perl\\s+-[^\\n]*i)\\b",                  // Block in-place edits
    "(?:^|[^<])>{1,2}(?:[^>]|$)"                                     // Block redirects
  ]
}
```

**When to customize**: Add project-specific dangerous patterns.

### Case Store

Controls case-based learning from previous runs.

```json
{
  "caseStore": {
    "enabled": true,            // Enable case recording
    "max": 200,                 // Max cases to retain
    "threshold": 0.35,          // Min similarity score to match (0-1)
    "matcher": "hybrid"         // "lexical" | "hybrid"
                                // lexical = token overlap only
                                // hybrid = tokens + trigrams + stack similarity
  }
}
```

**When to adjust**:
- `threshold`: Lower for more permissive matching (more case suggestions)
- `matcher`: Use "lexical" for faster matching on large case stores

### Retention

Controls log and session cleanup.

```json
{
  "retention": {
    "logsDays": 14,             // Keep RPC logs for N days (1-3650)
    "sessionsDays": 30          // Keep worker sessions for N days (1-3650)
  }
}
```

### UI

Controls dashboard rendering and batching.

```json
{
  "ui": {
    "renderThrottleMs": 250,    // Min ms between dashboard redraws (25-5000)
    "reportTriggerTurn": false, // Report injection triggers model turn
    "approvalBatchMs": 100      // Batch approval requests within N ms (0-2000)
  }
}
```

### Safety Guard Path

Optional path to custom safety guard extension loaded into all workers.

```json
{
  "safetyGuardPath": null       // Path to .ts extension file, or null
                                // Example: "~/.pi/agent/extensions/custom-guard.ts"
}
```

## Common Configuration Patterns

### Pattern 1: High-Throughput Large Refactor

For migrating 50+ files in parallel.

```json
{
  "planner": { "maxSubtasks": 12 },
  "worker": { 
    "maxConcurrency": 8,
    "perAgentBudgetUsd": 3
  },
  "run": { 
    "budgetUsd": 40,
    "failurePolicy": "continue-independent"
  }
}
```

### Pattern 2: High-Quality Critical Feature

For production features where correctness > cost.

```json
{
  "worker": {
    "bestOfN": 3,
    "maxRetries": 3
  },
  "run": {
    "verify": {
      "worker": ["npm test"],
      "integrationLight": ["npm run typecheck"],
      "full": ["npm test", "npm run typecheck", "npm run lint"]
    },
    "mergeStrategy": "branch"
  }
}
```

### Pattern 3: Untrusted Repository

Maximum safety for untrusted code.

```json
{
  "worker": {
    "strictBash": true,
    "scopeViolationPolicy": "fail",
    "tools": ["read", "edit", "write", "grep", "find", "ls"]  // No bash
  },
  "approvalPolicy": "autoDeny",
  "run": {
    "mergeStrategy": "branch",
    "verify": { "worker": null, "integrationLight": null, "full": null }
  }
}
```

### Pattern 4: Fast Iteration Low-Cost

For experimentation or low-stakes changes.

```json
{
  "planner": { "maxSubtasks": 4, "budgetUsd": 0.5 },
  "worker": { 
    "maxConcurrency": 2,
    "perAgentBudgetUsd": 1,
    "bestOfN": 1
  },
  "run": { 
    "budgetUsd": 5,
    "mergeStrategy": "branch"
  },
  "caseStore": { "enabled": true }  // Learn for next time
}
```

## Command-Line Overrides

Quick adjustments without editing config files:

```bash
# Override concurrency
/swarm "task" --max 8

# Override budget
/swarm "task" --budget 20

# Override model
/swarm "task" --model anthropic/claude-opus-4

# Enable best-of-N
/swarm "task" --best-of 3

# Force swarm (skip gate)
/swarm "task" --force

# Solo mode (passthrough to main agent, no swarm)
/swarm "task" --solo

# Plan-only (no execution)
/swarm "task" --plan-only
```

## How Claude Should Use This

When a user asks you to customize swarm behavior:

1. **Read this document** to understand available options
2. **Ask clarifying questions** about constraints (budget, time, quality vs speed)
3. **Generate appropriate config** in `.pi/swarm.json`
4. **Explain trade-offs** of the chosen configuration
5. **Test with `/swarm` command** and observe results
6. **Iterate** based on feedback

### Example User Request

> "我需要一个 swarm 配置，用于大规模重构，但是要确保质量，预算不是问题"

**Your response should**:
```json
{
  "planner": { 
    "maxSubtasks": 10,
    "budgetUsd": 2
  },
  "worker": { 
    "maxConcurrency": 6,
    "bestOfN": 2,
    "maxRetries": 3,
    "perAgentBudgetUsd": 5
  },
  "run": { 
    "budgetUsd": 60,
    "verify": {
      "worker": ["npm test"],
      "full": ["npm test", "npm run typecheck"]
    },
    "mergeStrategy": "branch"
  }
}
```

然后解释：这个配置支持最多 10 个并行子任务，每个任务运行 2 个候选方案取最优，总预算 $60，并在 worker 和最终阶段都运行测试验证。

