import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const engine = spawnSync(process.execPath, [join(here, "require-node.mjs")], { encoding: "utf8" });
if (engine.status !== 0) {
  process.stderr.write(engine.stderr || engine.stdout || "Node engine check failed\n");
  process.exit(engine.status ?? 1);
}

const files = [];
files.push("index.ts");
function walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
}
walk("src");
walk("test");
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || "";
    if (/ERR_UNKNOWN_FILE_EXTENSION|\.ts/.test(detail) && !/^v2[2-9]\.(?:1[9-9]|[2-9]\d)/.test(`v${process.versions.node}`)) {
      process.stderr.write(
        `${file}\n${detail}` +
          `Hint: Capstan is source-only TypeScript. Use Node.js >= 22.19 so \`node --check\` / \`node --test\` can load .ts files.\n`,
      );
    } else {
      process.stderr.write(`${file}\n${detail}`);
    }
    process.exitCode = 1;
  }
}
if (!process.exitCode) process.stdout.write(`syntax ok: ${files.length} TypeScript files\n`);
