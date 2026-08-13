export type GateDecision = "simple" | "complex";

export interface GateResult {
  decision: GateDecision;
  score: number;
  reason: string;
  ruleHits: string[];
  modelUsed: boolean;
  estimatedSubtasks: number;
}

export interface Contract {
  id: string;
  kind: "interface" | "api" | "schema" | "convention";
  description: string;
  definition: string;
}

export interface Acceptance {
  commands: string[];
  criteria: string[];
}

export interface Subtask {
  id: string;
  title: string;
  goal: string;
  role: string;
  rolePrompt: string;
  ownedPaths: string[];
  /** Files that may legitimately be touched by more than one task, such as lockfiles. */
  sharedPaths?: string[];
  /** Generated artifacts that are allowed even when they are outside ownedPaths. */
  generatedPaths?: string[];
  readPaths: string[];
  dependsOn: string[];
  contracts: string[];
  acceptance: Acceptance;
  model?: string;
  estTokens?: number;
}

export interface SwarmPlan {
  schemaVersion: 1;
  taskSummary: string;
  strategy: string;
  contracts: Contract[];
  subtasks: Subtask[];
  mergeOrder: string[];
  risks: string[];
}

export type RunPhase =
  | "gating"
  | "planning"
  | "reviewing"
  | "executing"
  | "finalizing"
  | "reporting"
  | "done"
  | "aborted"
  | "failed"
  | "interrupted";

export type WorkerStatus =
  | "pending"
  | "spawning"
  | "working"
  | "verifying"
  | "fixing"
  | "awaiting"
  | "merging"
  | "done"
  | "failed"
  | "blocked"
  | "paused"
  | "detached"
  | "killed";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface PendingUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface WorkerRuntime {
  subtaskId: string;
  status: WorkerStatus;
  pid?: number;
  pidStartedAt?: number;
  pidMarker?: string;
  sessionFile?: string;
  worktree: string;
  branch: string;
  currentAction: string;
  lastText?: string;
  completionReport?: string;
  usage: UsageTotals;
  turns: number;
  retries: number;
  pendingUi: PendingUiRequest[];
  lastEventAt: number;
  startedAt?: number;
  endedAt?: number;
  scopeViolations: string[];
  stallCount?: number;
  activeTools?: number;
  activeToolStartedAt?: number;
  setupComplete?: boolean;
  revertedScopePaths?: string[];
  blockedBy?: string[];
  mailboxOffset?: number;
  competition?: {
    winner: string;
    attempts: Array<{ id: string; status: WorkerStatus; branch: string; retries: number; cost: number; verificationOk: boolean }>;
  };
  interruptedTurn?: boolean;
  verification?: VerificationResult;
  launch?: WorkerLaunchManifest;
}

export interface WorkerLaunchManifest {
  guardPath: string;
  promptPath: string;
  sessionDir: string;
  model?: string | null;
  tools: string[];
  projectTrusted: boolean;
  safetyGuardPath?: string | null;
}

export interface PlanningRuntime {
  startedAt: number;
  endedAt?: number;
  timeoutMs: number;
  calls: number;
  turns: number;
  usage: UsageTotals;
}

export type GitOperationPhase = "prepared" | "merging" | "candidate" | "verified" | "promoted" | "discarded";

export interface GitMergeOperation {
  operationId: string;
  kind: "wave" | "repair";
  phase: GitOperationPhase;
  preMergeSha: string;
  candidateBranch: string;
  candidateWorktree: string;
  subtaskIds: string[];
  pendingSubtaskId?: string;
  candidateSha?: string;
  postMergeSha?: string;
  verification?: VerificationResult;
  startedAt: number;
  updatedAt: number;
  setupComplete?: boolean;
}

export interface EffectiveBudget {
  workerBudgetUsd: number;
  workerTokenLimit: number;
  runBudgetUsd: number;
  runTokenLimit: number;
}

export interface ConflictRecord {
  incomingSubtask: string;
  files: string[];
  resolved: boolean;
  note?: string;
}

export interface GitRunState {
  repoRoot: string;
  baseCommit: string;
  originBranch: string;
  integrationBranch: string;
  integrationWorktree: string;
  dirtyBase: boolean;
  initialHead: string;
  initialStatusHash: string;
}

export interface SwarmRun {
  schemaVersion: 1;
  runId: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  task: string;
  phase: RunPhase;
  gate?: GateResult;
  plan?: SwarmPlan;
  planning?: PlanningRuntime;
  effectiveBudget?: EffectiveBudget;
  planEdits: string[];
  planRevision?: number;
  git?: GitRunState;
  workers: Record<string, WorkerRuntime>;
  merged: string[];
  conflicts: ConflictRecord[];
  gitOperations?: GitMergeOperation[];
  totals: UsageTotals & { wallSec: number; turns: number };
  outcome?: "planned" | "applied" | "branch" | "committed" | "aborted" | "failed";
  caseId?: string;
  error?: string;
  runDir: string;
  reportPath?: string;
  partialSuccess?: boolean;
  leadMailboxOffset?: number;
  integrationSetupComplete?: boolean;
  prUrl?: string;
}

export interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  blocked?: boolean;
  aborted?: boolean;
}

export interface VerificationResult {
  ok: boolean;
  commands: VerificationCommandResult[];
}

export interface WorkerEventMap {
  action: { label: string };
  tool: { active: boolean; name?: string; reset?: boolean };
  text: { text: string };
  activity: Record<string, never>;
  usage: { usage: UsageTotals; turns: number };
  settled: Record<string, never>;
  ui: { request: PendingUiRequest & Record<string, unknown> };
  retrying: { attempt: number; maxAttempts: number };
  exit: { code: number; stderr: string };
  state: { sessionFile?: string; sessionId?: string; pidMarker?: string };
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  waves: string[][];
}

export type MergeStrategy = "branch" | "apply" | "commit";

export interface SwarmConfig {
  gate: {
    model: string | null;
    ruleThresholdHigh: number;
    ruleThresholdLow: number;
  };
  planner: {
    model: string | null;
    maxSubtasks: number;
    repoMapTokens: number;
    schemaRetries: number;
    timeoutSec: number;
    budgetUsd: number;
    tokenLimit: number;
  };
  worker: {
    model: string | null;
    maxConcurrency: number;
    maxRetries: number;
    stallSec: number;
    wallClockMin: number;
    perAgentBudgetUsd: number;
    perAgentTokenLimit: number;
    tools: string[];
    setupCommands: string[];
    setupTimeoutSec: number;
    shareDependencyDirs: string[];
    scopeAllowlist: string[];
    scopeViolationPolicy: "fail" | "revert";
    bestOfN: number;
    bestOfNJudge: boolean;
  };
  run: {
    budgetUsd: number;
    tokenLimit: number;
    mergeStrategy: MergeStrategy;
    verify: {
      worker: string[] | null;
      integrationLight: string[] | null;
      full: string[] | null;
    };
    verifyTimeoutSec: number;
    verifyAllowedPrefixes: string[];
    setupAllowedPrefixes: string[];
    failurePolicy: "fail-fast" | "continue-independent";
  };
  approvalPolicy: "route" | "autoDeny" | "autoAllow";
  bashDenylist: string[];
  caseStore: {
    enabled: boolean;
    max: number;
    threshold: number;
    matcher: "lexical" | "hybrid";
  };
  retention: {
    logsDays: number;
    sessionsDays: number;
  };
  ui: {
    renderThrottleMs: number;
    reportTriggerTurn: boolean;
    approvalBatchMs: number;
  };
  safetyGuardPath: string | null;
}

export interface ParsedSwarmCommand {
  action: "run" | "board" | "pause" | "resume" | "abort" | "merge" | "pr" | "replan" | "clean" | "cases" | "replay" | "config" | "status" | "help";
  task: string;
  force: boolean;
  solo: boolean;
  planOnly: boolean;
  max?: number;
  budget?: number;
  bestOf?: number;
  model?: string;
  rest: string[];
  warnings: string[];
}

export interface CaseRecord {
  id: string;
  ts: number;
  repoFingerprint: {
    langs: string[];
    frameworks: string[];
    sizeBucket: "s" | "m" | "l";
  };
  taskText: string;
  taskTags: string[];
  planSkeleton: {
    subtaskCount: number;
    waves: number;
    roles: string[];
    dagShape: string;
    contractKinds: string[];
    ownershipPattern: string;
  };
  strategy: string;
  metrics: {
    onePassRate: number;
    retries: number;
    conflicts: number;
    durationSec: number;
    cost: number;
    planEditCount: number;
  };
  rating: { explicit: -1 | 0 | 1; implicit: number };
  outcome: "applied" | "branch" | "committed" | "aborted" | "failed";
}
