export interface BenchAttempt {
  outcome: string;
  expectOutcome?: string;
  error?: string | null;
  failClass?: string | null;
  category?: string;
  fixture?: string;
  difficulty?: string;
  golden?: { pass: boolean } | null;
  contractEntity?: { checked: number; hits: number };
  schemaRetriesUsed?: number;
  firstPassValid?: boolean;
  qualityPass?: boolean;
  cost?: number;
  tokens?: number;
  wallMs?: number;
}

export interface BenchRow extends BenchAttempt {
  attempts?: BenchAttempt[];
}

export function classifyFail(row: BenchAttempt): string | null {
  const error = row.error ?? "";
  if (/budget/i.test(error)) return "budget";
  if (/429|rate.?limit/i.test(error)) return "rate_limit_429";
  if (/\b5\d\d\b|service unavailable|bad gateway|internal server error/i.test(error)) return "provider_5xx";
  if (/aborted|timeout|timed out/i.test(error)) return "timeout";
  if (/401|403|unauthorized|authentication|No authenticated/i.test(error)) return "auth";
  if (/404|model.*not found|unknown model/i.test(error)) return "model_unavailable";
  if (/fetch failed|ENOTFOUND|ECONN|network/i.test(error)) return "network";
  if (/output token limit/i.test(error)) return "output_limit";
  if (/JSON|parse|Expected ','/i.test(error)) return "json_parse";
  if (/计划校验失败|validate/i.test(error)) return "schema_invalid";
  if (error || row.outcome === "error" || row.outcome === "invalid") return "unknown_error";
  if (row.expectOutcome === "plan" && row.outcome === "solo") return "solo_unexpected";
  if (row.expectOutcome === "solo" && row.outcome === "plan") return "plan_unexpected";
  if (row.outcome === "plan" && row.golden?.pass === false) return "golden_fail";
  return null;
}

export function isInfrastructureFailure(row: BenchAttempt): boolean {
  return ["rate_limit_429", "provider_5xx", "timeout", "auth", "model_unavailable", "network"].includes(row.failClass ?? classifyFail(row) ?? "");
}

export function qualityPassFor(row: BenchAttempt): boolean {
  const expect = row.expectOutcome ?? "plan";
  if (expect === "solo") return row.outcome === "solo";
  if (expect === "plan" && row.outcome !== "plan") return false;
  if (!["plan", "solo"].includes(row.outcome)) return false;
  return row.outcome !== "plan" || row.golden?.pass !== false;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type Bucket = { n: number; planOk: number; solo: number; errors: number; goldenPass: number; qualityPass: number };

export function computeTotals(rows: BenchRow[]) {
  const firstAttempts = rows.map((row) => row.attempts?.[0] ?? row);
  const attempts = rows.flatMap((row) => row.attempts?.length ? row.attempts : [row]);
  const eligible = rows.filter((row) => !isInfrastructureFailure(row));
  const successful = rows.filter((row) => ["plan", "solo"].includes(row.outcome));
  const golden = rows.filter((row) => row.golden);
  const expectPlan = eligible.filter((row) => (row.expectOutcome ?? "plan") === "plan");
  const expectSolo = eligible.filter((row) => row.expectOutcome === "solo");
  const entityChecks = rows.reduce((sum, row) => sum + (row.contractEntity?.checked ?? 0), 0);
  const byCategory: Record<string, Bucket> = {};
  const byFixture: Record<string, Bucket> = {};
  const byDifficulty: Record<string, Bucket> = {};
  const byFailClass: Record<string, number> = {};
  for (const row of rows) {
    const failure = classifyFail(row);
    if (failure) byFailClass[failure] = (byFailClass[failure] ?? 0) + 1;
    for (const [map, key] of [[byCategory, row.category], [byFixture, row.fixture], [byDifficulty, row.difficulty]] as const) {
      const bucket = map[key ?? "unknown"] ??= { n: 0, planOk: 0, solo: 0, errors: 0, goldenPass: 0, qualityPass: 0 };
      bucket.n++;
      if (row.outcome === "plan") bucket.planOk++;
      if (row.outcome === "solo") bucket.solo++;
      if (["error", "invalid"].includes(row.outcome)) bucket.errors++;
      if (row.golden?.pass) bucket.goldenPass++;
      if (qualityPassFor(row)) bucket.qualityPass++;
    }
  }
  const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
  return {
    runs: rows.length,
    attempts: attempts.length,
    planOk: rows.filter((row) => row.outcome === "plan").length,
    solo: rows.filter((row) => row.outcome === "solo").length,
    errors: rows.filter((row) => row.outcome === "error").length,
    invalid: rows.filter((row) => row.outcome === "invalid").length,
    firstPassValidRate: rate(firstAttempts.filter((row) => row.firstPassValid).length, rows.length),
    firstAttemptCompletionRate: rate(firstAttempts.filter((row) => ["plan", "solo"].includes(row.outcome)).length, rows.length),
    schemaFirstFailRate: rate(firstAttempts.filter((row) => (row.schemaRetriesUsed ?? 0) > 0).length, rows.length),
    contractEntityHitRate: rate(rows.reduce((sum, row) => sum + (row.contractEntity?.hits ?? 0), 0), entityChecks),
    goldenPassRate: rate(golden.filter((row) => row.golden?.pass).length, golden.length),
    plannerQualityScore: rate(eligible.filter(qualityPassFor).length, eligible.length),
    qualityEligibleCases: eligible.length,
    completionRate: rate(successful.length, rows.length),
    eligibleCompletionRate: rate(eligible.filter((row) => ["plan", "solo"].includes(row.outcome)).length, eligible.length),
    soloRegretRate: rate(expectPlan.filter((row) => row.outcome === "solo").length, expectPlan.length),
    soloMissRate: rate(expectSolo.filter((row) => row.outcome === "plan").length, expectSolo.length),
    infraFailRate: rate(rows.length - eligible.length, rows.length),
    totalCost: attempts.reduce((sum, row) => sum + (row.cost ?? 0), 0),
    totalTokens: attempts.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
    medianWallMs: median(rows.map((row) => (row.attempts ?? [row]).reduce((sum, attempt) => sum + (attempt.wallMs ?? 0), 0))),
    crossTabs: { byCategory, byFixture, byDifficulty, byFailClass },
  };
}
