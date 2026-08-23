import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("config loading falls back to swarm.json but prefers capstan.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-config-"));
  const agentDir = join(root, "agent");
  const repo = join(root, "repo");
  const projectDir = join(repo, ".pi");
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(agentDir, "swarm.json"), JSON.stringify({
      worker: { maxConcurrency: 3, tools: ["read", "swarm_send", "swarm_inbox", "swarm_fs", "custom_tool"] },
    }));
    await writeFile(join(projectDir, "swarm.json"), JSON.stringify({ run: { budgetUsd: 4 } }));

    const legacy = await loadConfig(agentDir, repo, ".pi");
    assert.equal(legacy.worker.maxConcurrency, 3);
    assert.deepEqual(legacy.worker.tools, ["read", "capstan_send", "capstan_inbox", "capstan_fs", "custom_tool"]);
    assert.equal(legacy.run.budgetUsd, 4);

    await writeFile(join(agentDir, "capstan.json"), JSON.stringify({ worker: { maxConcurrency: 5 } }));
    await writeFile(join(projectDir, "capstan.json"), JSON.stringify({ run: { budgetUsd: 6 } }));

    const renamed = await loadConfig(agentDir, repo, ".pi");
    assert.equal(renamed.worker.maxConcurrency, 5);
    assert.equal(renamed.run.budgetUsd, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
