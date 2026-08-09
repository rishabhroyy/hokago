import { existsSync } from "node:fs";
import path from "node:path";

export function configDir(): string {
  return process.env.HOKAGO_CONFIG_DIR ?? "./data/config";
}

/**
 * Resolve a stored config-file path (artwork bytesPath, font path). Rows may
 * have been recorded in a different environment than the one serving them —
 * host-absolute (/Users/.../data/config/...) or cwd-relative. If the stored
 * path isn't visible, fall back to configDir()/<subdir>/<basename>; the
 * content-addressed stores make the basename the authoritative key.
 */
export function resolveConfigFilePath(stored: string, subdir: string): string | null {
  if (existsSync(stored)) return stored;
  const fallback = path.join(configDir(), subdir, path.basename(stored));
  return existsSync(fallback) ? fallback : null;
}
