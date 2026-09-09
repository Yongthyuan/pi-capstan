import test from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue } from "../src/serial-queue.ts";

test("serial queue runs tasks FIFO even when enqueued concurrently", async () => {
  const queue = createSerialQueue();
  const snapshot: string[] = [];
  const delays = [30, 5, 15];

  const results = await Promise.all(
    delays.map((ms, index) =>
      queue.enqueue(async () => {
        snapshot.push(`start-${index}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        snapshot.push(`end-${index}`);
        return index;
      }),
    ),
  );

  assert.deepEqual(results, [0, 1, 2]);
  assert.deepEqual(snapshot, ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
});

test("serial queue continues after a rejected task", async () => {
  const queue = createSerialQueue();
  const snapshot: string[] = [];

  const first = queue.enqueue(async () => {
    snapshot.push("a");
    throw new Error("boom");
  });
  const second = queue.enqueue(async () => {
    snapshot.push("b");
    return "ok";
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  await queue.drain();
  assert.deepEqual(snapshot, ["a", "b"]);
});

test("drain waits for in-flight work", async () => {
  const queue = createSerialQueue();
  let done = false;
  void queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    done = true;
  });
  await queue.drain();
  assert.equal(done, true);
});
