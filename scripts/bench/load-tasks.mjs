import { catalogManifest } from "./task-catalog.mjs";

/**
 * @param {{ suite?: string, category?: string, fixture?: string, limit?: number, tag?: string }} filters
 */
export function loadTasks(filters = {}) {
  const manifest = catalogManifest();
  const suite = filters.suite ?? "full";
  let tasks = manifest.tasks.filter((task) => {
    if (suite !== "full" && !(task.suites ?? []).includes(suite)) return false;
    if (filters.category && task.category !== filters.category) return false;
    if (filters.tag && !(task.tags ?? []).includes(filters.tag)) return false;
    return true;
  });

  /** @type {Array<{ task: object, fixtureName: string }>} */
  const cases = [];
  for (const task of tasks) {
    const fixtures = filters.fixture
      ? task.fixtures.filter((f) => f === filters.fixture)
      : task.fixtures;
    for (const fixtureName of fixtures) {
      if (!manifest.fixtures.includes(fixtureName)) {
        throw new Error(`task ${task.id} references unknown fixture ${fixtureName}`);
      }
      cases.push({ task, fixtureName });
    }
  }

  if (filters.limit && filters.limit > 0) {
    cases.splice(filters.limit);
  }

  return { manifest, tasks, cases };
}

export function summarizeCatalog() {
  const { manifest, cases: fullCases } = loadTasks({ suite: "full" });
  const smoke = loadTasks({ suite: "smoke" });
  const core = loadTasks({ suite: "core" });
  const byCategory = {};
  for (const task of manifest.tasks) {
    byCategory[task.category] = (byCategory[task.category] ?? 0) + 1;
  }
  return {
    version: manifest.version,
    taskCount: manifest.tasks.length,
    fixtureCount: manifest.fixtures.length,
    fullCases: fullCases.length,
    smokeCases: smoke.cases.length,
    coreCases: core.cases.length,
    byCategory,
  };
}
