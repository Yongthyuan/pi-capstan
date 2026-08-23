import test from "node:test";
import assert from "node:assert/strict";
import { buildManualTakeoverCommand } from "../src/orchestrator.ts";
import { processMarkerCommand } from "../src/process-identity.ts";

test("manual takeover command is native to POSIX and PowerShell", () => {
  const posix = buildManualTakeoverCommand("/tmp/work tree", "/tmp/run", ["pi", "--no-extensions"], "darwin");
  assert.match(posix, /^cd /);
  assert.match(posix, /env PI_CAPSTAN_WORKER=1/);
  const windows = buildManualTakeoverCommand("C:\\work tree", "C:\\run", ["pi", "--no-extensions"], "win32");
  assert.match(windows, /^Set-Location -LiteralPath/);
  assert.match(windows, /\$env:PI_CAPSTAN_WORKER='1'/);
  assert.equal(windows.includes("&& env"), false);
});

test("process identity uses platform-native creation markers", () => {
  assert.equal(processMarkerCommand("linux", 42).command, "ps");
  const windows = processMarkerCommand("win32", 42);
  assert.equal(windows.command, "powershell.exe");
  assert.equal(windows.args.at(-1)?.includes("ProcessId=42"), true);
});
