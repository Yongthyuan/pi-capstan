/**
 * Fail fast with an actionable message when Node cannot load Capstan's
 * TypeScript-source package (requires native strip-types, Node >= 22.19).
 */
const required = { major: 22, minor: 19 };
const parts = process.versions.node.split(".").map((part) => Number(part));
const major = parts[0] ?? 0;
const minor = parts[1] ?? 0;
const ok = major > required.major || (major === required.major && minor >= required.minor);
if (!ok) {
  process.stderr.write(
    `pi-capstan requires Node.js >= ${required.major}.${required.minor} (current ${process.version}).\n` +
      `This package ships TypeScript sources and needs Node's built-in strip-types support.\n` +
      `Fix: install Node ${required.major}.${required.minor}+ (e.g. \`nvm install ${required.major}.${required.minor}\` or https://nodejs.org/).\n`,
  );
  process.exit(1);
}
