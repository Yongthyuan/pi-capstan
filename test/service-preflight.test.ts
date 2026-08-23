import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCapstanCommand } from "../src/command.ts";
import { CapstanService } from "../src/service.ts";

test("parseCapstanCommand recognizes --plan-only and -n without corrupting task text", () => {
  const long = parseCapstanCommand("refactor auth module --plan-only");
  assert.equal(long.task, "refactor auth module");
  assert.equal(long.planOnly, true);

  const short = parseCapstanCommand("draft release notes -n");
  assert.equal(short.task, "draft release notes");
  assert.equal(short.planOnly, true);

  const off = parseCapstanCommand("ship it");
  assert.equal(off.task, "ship it");
  assert.equal(off.planOnly, false);
});

test("non-git directories abort after solo gating with an actionable notice and zero planner cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "capstan-preflight-"));
  const notifications: string[] = [];
  let handedBack = false;
  const pi: any = {
    sendUserMessage: () => {
      handedBack = true;
    },
    appendEntry: () => {},
    sendMessage: async () => {},
  };
  const ctx: any = {
    cwd: root,
    ui: { notify: (message: string) => notifications.push(message), confirm: async () => true },
    ...pi,
  };
  try {
    const service = new CapstanService(pi, join(root, "agent"), ".pi");

    // A simple task must still hand off to solo even without Git (gate rules score it simple).
    await service.runTask("fix typo", ctx);
    assert.ok(handedBack, "simple tasks in non-git directories should hand back to solo");
    assert.equal(service.activeRun?.phase ?? "done", "done");

    // A complex task (--force skips gate ambiguity) must abort right after gating, pre-planner.
    handedBack = false;
    notifications.length = 0;
    await service.runTask("build a multi-part payments system", ctx, { force: true });
    const joined = notifications.join("\n");
    assert.match(joined, /Git repository/);
    assert.match(joined, /Git 仓库/);
    assert.equal(handedBack, false, "complex non-git tasks must not hand off to solo");

    const runsRoot = join(root, ".pi", "capstan", "runs");
    const states = await Promise.all(
      (await readdir(runsRoot)).map((entry) => readFile(join(runsRoot, entry, "state.json"), "utf8").then(JSON.parse)),
    );
    assert.equal(states.length, 2);
    assert.deepEqual(
      states.map((state: any) => [state.phase, state.outcome]).sort(),
      [
        ["done", "aborted"],
        ["done", "planned"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
