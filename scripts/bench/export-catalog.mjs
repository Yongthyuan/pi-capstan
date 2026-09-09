import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogManifest } from "./task-catalog.mjs";
import { loadTasks, summarizeCatalog } from "./load-tasks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = catalogManifest();
const summary = summarizeCatalog();
const smoke = loadTasks({ suite: "smoke" });

await mkdir(join(__dirname, "tasks"), { recursive: true });
await mkdir(join(__dirname, "suites"), { recursive: true });

await writeFile(join(__dirname, "tasks.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(__dirname, "suites/smoke.lock.json"),
  `${JSON.stringify(
    {
      version: manifest.version,
      suite: "smoke",
      cases: smoke.cases.map((c) => `${c.task.id}@${c.fixtureName}`),
    },
    null,
    2,
  )}\n`,
);
await writeFile(join(__dirname, "catalog-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
