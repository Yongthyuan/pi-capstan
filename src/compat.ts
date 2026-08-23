export interface PiCapabilities {
  registerCommand?: unknown;
  registerTool?: unknown;
  registerMessageRenderer?: unknown;
  on?: unknown;
}

export type CompatibilityLevel = "tested" | "compatible" | "unsupported";

export function assessPiCompatibility(version: string, api: PiCapabilities): { level: CompatibilityLevel; message: string } {
  const missing = ["registerCommand", "registerTool", "registerMessageRenderer", "on"].filter((key) => typeof api[key as keyof PiCapabilities] !== "function");
  if (missing.length) return { level: "unsupported", message: `Pi API 缺少能力: ${missing.join(", ")}` };
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return { level: "unsupported", message: `无法解析 Pi 版本 ${version}` };
  const [, major, minor, patch] = match.map(Number);
  if (major === 0 && (minor < 84 || (minor === 84 && patch < 1))) return { level: "unsupported", message: `Pi ${version} 低于最低支持版本 0.84.1` };
  if (major === 0 && minor === 84 && patch === 1) return { level: "tested", message: "Pi 0.84.1 已通过原生回归" };
  if (major === 0 && minor === 84) return { level: "compatible", message: `Pi ${version} 满足 0.84.x 能力契约，但不是已验证构建` };
  // Newer Pi releases load with a warning instead of refusing to start:
  // the capability probe above is the real gate, and dying on every minor
  // bump would strand users until a new capstan release ships.
  return { level: "compatible", message: `Pi ${version} 超出已验证范围（tested: 0.84.1）；能力契约满足，继续加载。如遇异常请回退 Pi 0.84.x 并反馈` };
}
