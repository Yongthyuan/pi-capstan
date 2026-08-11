import test from "node:test";
import assert from "node:assert/strict";
import { assessPiCompatibility } from "../src/compat.ts";

const api = { registerCommand() {}, registerTool() {}, registerMessageRenderer() {}, on() {} };

test("Pi compatibility is capability-gated and bounded to the tested minor", () => {
  assert.equal(assessPiCompatibility("0.84.1", api).level, "tested");
  assert.equal(assessPiCompatibility("0.84.9", api).level, "compatible");
  assert.equal(assessPiCompatibility("0.85.0", api).level, "unsupported");
  assert.equal(assessPiCompatibility("0.84.1", { ...api, registerTool: undefined }).level, "unsupported");
});
