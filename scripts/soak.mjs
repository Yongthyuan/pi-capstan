import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Repeated test-suite runs to surface timing flakes that a single green run
// hides. Usage: node scripts/soak.mjs [iterations] [test-name-pattern]
const iterations = Math.max(1, Math.trunc(Number(process.argv[2]) || 20));
const pattern = process.argv[3];
// SOAK_TEST_ARGS mirrors the extra runner flags CI needs (e.g. Node 22
// isolation flags on Windows) without changing local default behavior.
const extraArgs = (process.env.SOAK_TEST_ARGS ?? "").split(/\s+/).filter(Boolean);
const files = readdirSync("test").filter((file) => file.endsWith(".test.ts")).map((file) => `test/${file}`);
const failures = [];

for (let run = 1; run <= iterations; run++) {
  const started = Date.now();
  const args = ["--test", ...extraArgs, ...(pattern ? ["--test-name-pattern", pattern] : []), ...files];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const ok = result.status === 0;
  console.log(`run ${run}/${iterations}: ${ok ? "pass" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failures.push(run);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const interesting = output.split("\n").filter((line) => line.includes("✖") || line.includes("AssertionError")).slice(0, 20);
    console.log(interesting.join("\n"));
  }
}

console.log(`\nsoak: ${iterations - failures.length}/${iterations} green${failures.length ? `; failed runs: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
