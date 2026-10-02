import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PiLaunch {
  command: string;
  argsPrefix: string[];
  source: string;
}

/**
 * Resolve how to spawn a Pi worker RPC process.
 * Prefer an explicit env override, then the parent Pi CLI (process.argv[1]),
 * then the packaged `@earendil-works/pi-coding-agent` cli.js next to this install,
 * and finally a bare `pi` on PATH.
 */
export async function resolvePiLaunch(env: NodeJS.ProcessEnv = process.env): Promise<PiLaunch> {
  const override = env.PI_CAPSTAN_PI_BIN?.trim();
  if (override) {
    if (override.endsWith(".js") || override.endsWith(".mjs") || override.endsWith(".cjs") || override.endsWith(".ts")) {
      return { command: process.execPath, argsPrefix: [override], source: "PI_CAPSTAN_PI_BIN" };
    }
    return { command: override, argsPrefix: [], source: "PI_CAPSTAN_PI_BIN" };
  }

  const parent = await resolveFromParentArgv();
  if (parent) return parent;

  const packaged = await resolvePackagedCli();
  if (packaged) return packaged;

  return { command: "pi", argsPrefix: [], source: "path" };
}

export function formatPiLaunchError(error: unknown, launch: PiLaunch): Error {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || /ENOENT/i.test(message)) {
    return new Error(
      `Failed to start Pi worker (${launch.command}${launch.argsPrefix[0] ? ` ${launch.argsPrefix[0]}` : ""}; via ${launch.source}): command not found.\n` +
        "Fix: install Pi ≥0.84.1 so `pi` is on PATH, run Capstan from inside Pi, or set PI_CAPSTAN_PI_BIN to the Pi binary / cli.js path.\n" +
        "无法启动 Pi worker：找不到命令。请安装 Pi，或设置 PI_CAPSTAN_PI_BIN。",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function resolveFromParentArgv(): Promise<PiLaunch | undefined> {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const normalized = entry.replaceAll("\\", "/");
  const looksLikePiCli =
    /(?:^|\/)pi(?:\.js|\.mjs|\.cjs)?$/i.test(normalized)
    || /pi-coding-agent\/dist\/(?:cli|main|rpc-entry)\.js$/i.test(normalized)
    || /@earendil-works\/pi-coding-agent\/dist\/(?:cli|main|rpc-entry)\.js$/i.test(normalized);
  if (!looksLikePiCli) return undefined;
  try {
    await access(entry);
  } catch {
    return undefined;
  }
  if (entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".cjs") || entry.endsWith(".ts")) {
    return { command: process.execPath, argsPrefix: [entry], source: "parent-argv" };
  }
  return { command: entry, argsPrefix: [], source: "parent-argv" };
}

async function resolvePackagedCli(): Promise<PiLaunch | undefined> {
  const candidates: string[] = [];
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@earendil-works/pi-coding-agent");
    candidates.push(join(dirname(pkg), "cli.js"));
    candidates.push(join(dirname(pkg), "rpc-entry.js"));
  } catch {
    // Peer may only be resolvable from the host install.
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
    candidates.push(join(here, "..", "..", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  } catch {
    // ignore
  }
  for (const candidate of candidates) {
    const absolute = isAbsolute(candidate) ? candidate : join(process.cwd(), candidate);
    try {
      await access(absolute);
      return { command: process.execPath, argsPrefix: [absolute], source: "packaged-cli" };
    } catch {
      // try next
    }
  }
  return undefined;
}
