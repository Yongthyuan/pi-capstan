/**
 * FIFO promise chain used by the orchestrator for persist / merge / setup / UI.
 * Extracted so timing invariants can be unit-tested without spinning workers.
 */
export type SerialQueue = {
  /** Enqueue work; previous tasks finish (success or failure) before this runs. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Wait until every enqueued task has settled. */
  drain(): Promise<void>;
};

export function createSerialQueue(): SerialQueue {
  let chain: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const result = chain.then(task, task);
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    drain() {
      return chain;
    },
  };
}
