import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Repeated test-suite runs to surface timing flakes that a single green run
// hides. Usage: node scripts/soak.mjs [iterations] [test-name-pattern]
const iterations = Math.max(1, Math.trunc(Number(process.argv[2]) || 20));
const pattern = process.argv[3];
// SOAK_TEST_ARGS mirrors the extra runner flags CI needs (e.g. Node 22
// isolation flags on Windows) without changing local default behavior.
const extraArgs = (process.env.SOAK_TEST_ARGS ?? "").split(/\s+/).filter(Boolean);
const reporterArgs = extraArgs.some((arg) => arg === "--test-reporter" || arg.startsWith("--test-reporter="))
  ? []
  : ["--test-reporter=tap"];
const files = readdirSync("test").filter((file) => file.endsWith(".test.ts")).map((file) => `test/${file}`);
const failures = [];

function failureExcerpt(output) {
  const lines = output.split("\n");
  const starts = lines.flatMap((line, index) => /^\s*not ok \d+ - /.test(line) ? [index] : []);
  if (!starts.length) return lines.slice(-120).join("\n").trim();
  const blocks = starts.map((start) => {
    let end = start + 1;
    while (end < lines.length && !/^\s*(?:ok|not ok) \d+ - /.test(lines[end])) end++;
    return lines.slice(start, end).join("\n").trimEnd();
  });
  return blocks.join("\n").slice(0, 20_000).trim();
}

for (let run = 1; run <= iterations; run++) {
  const started = Date.now();
  const args = ["--test", ...reporterArgs, ...extraArgs, ...(pattern ? ["--test-name-pattern", pattern] : []), ...files];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const ok = result.status === 0;
  console.log(`run ${run}/${iterations}: ${ok ? "pass" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failures.push(run);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    console.log(failureExcerpt(output));
  }
}

console.log(`\nsoak: ${iterations - failures.length}/${iterations} green${failures.length ? `; failed runs: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
