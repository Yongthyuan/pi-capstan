import { runCommand } from "./utils.ts";

export async function processMarker(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const result = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) return undefined;
    const marker = result.stdout.trim().replace(/\s+/g, " ");
    return marker || undefined;
  } catch {
    return undefined;
  }
}

export async function processMatches(pid: number | undefined, expectedMarker?: string): Promise<boolean> {
  const status = await processIdentityStatus(pid, expectedMarker);
  return status === "match" || status === "unknown";
}

export async function processIdentityStatus(pid: number | undefined, expectedMarker?: string): Promise<"dead" | "match" | "mismatch" | "unknown"> {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
  } catch {
    return "dead";
  }
  if (!expectedMarker) return "match";
  const actual = await processMarker(pid);
  if (!actual) return "unknown";
  return actual === expectedMarker ? "match" : "mismatch";
}

export async function stopOwnedProcess(pid: number, expectedMarker: string, graceMs = 2_000): Promise<boolean> {
  if (await processIdentityStatus(pid, expectedMarker) !== "match") return false;
  signal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (await processIdentityStatus(pid, expectedMarker) === "dead") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await processIdentityStatus(pid, expectedMarker) === "match") signal(pid, "SIGKILL");
  return true;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, name);
  } catch {
    try { process.kill(pid, name); } catch { /* Process already exited. */ }
  }
}
