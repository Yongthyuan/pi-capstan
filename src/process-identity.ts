import { runCommand } from "./utils.ts";

export async function processMarker(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const spec = processMarkerCommand(process.platform, pid);
    const result = await runCommand(spec.command, spec.args, { timeoutMs: 5_000 });
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
  if (process.platform === "win32") await runCommand("taskkill", ["/PID", String(pid), "/T"], { timeoutMs: 5_000 }).catch(() => undefined);
  else signal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (await processIdentityStatus(pid, expectedMarker) === "dead") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await processIdentityStatus(pid, expectedMarker) === "match") {
    if (process.platform === "win32") await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 5_000 }).catch(() => undefined);
    else signal(pid, "SIGKILL");
  }
  return true;
}

export function processMarkerCommand(platform: NodeJS.Platform, pid: number): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate.ToUniversalTime().ToString(\"o\")`],
    };
  }
  return { command: "ps", args: ["-o", "lstart=", "-p", String(pid)] };
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, name);
  } catch {
    try { process.kill(pid, name); } catch { /* Process already exited. */ }
  }
}
