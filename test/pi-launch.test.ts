import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { formatPiLaunchError, resolvePiLaunch } from "../src/pi-launch.ts";

test("resolvePiLaunch prefers PI_CAPSTAN_PI_BIN for scripts and binaries", async () => {
  const script = await resolvePiLaunch({ PI_CAPSTAN_PI_BIN: "/tmp/custom/cli.js" });
  assert.equal(script.command, process.execPath);
  assert.deepEqual(script.argsPrefix, ["/tmp/custom/cli.js"]);
  assert.equal(script.source, "PI_CAPSTAN_PI_BIN");

  const binary = await resolvePiLaunch({ PI_CAPSTAN_PI_BIN: "/usr/local/bin/pi" });
  assert.equal(binary.command, "/usr/local/bin/pi");
  assert.deepEqual(binary.argsPrefix, []);
});

test("resolvePiLaunch finds packaged peer cli.js when env unset", async () => {
  const previous = process.env.PI_CAPSTAN_PI_BIN;
  delete process.env.PI_CAPSTAN_PI_BIN;
  try {
    const launch = await resolvePiLaunch({});
    assert.equal(launch.command, process.execPath);
    assert.ok(launch.argsPrefix[0]?.includes(join("pi-coding-agent", "dist", "cli.js")));
    assert.equal(launch.source, "packaged-cli");
  } finally {
    if (previous === undefined) delete process.env.PI_CAPSTAN_PI_BIN;
    else process.env.PI_CAPSTAN_PI_BIN = previous;
  }
});

test("formatPiLaunchError turns ENOENT into an actionable message", () => {
  const error = Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
  const formatted = formatPiLaunchError(error, { command: "pi", argsPrefix: [], source: "path" });
  assert.match(formatted.message, /PI_CAPSTAN_PI_BIN/);
  assert.match(formatted.message, /无法启动 Pi worker/);
});
