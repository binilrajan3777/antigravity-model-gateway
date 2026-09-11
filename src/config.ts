/**
 * Filesystem locations, resolved identically on Windows, macOS and Linux.
 *
 * Everything lives under `~/.gemini/antigravity/` — the same directory the
 * Antigravity toolchain already uses — so there is no per-platform branching.
 * `os.homedir()` handles the platform difference for us.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** `~/.gemini/antigravity` */
export function configDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

/** The custom model definitions. Override with ANTIGRAVITY_MODELS_FILE. */
export function customModelsPath(): string {
  return process.env.ANTIGRAVITY_MODELS_FILE || path.join(configDir(), 'custom_models.json');
}

/** Proxy log file. Override with ANTIGRAVITY_PROXY_LOG. */
export function logFilePath(): string {
  return process.env.ANTIGRAVITY_PROXY_LOG || path.join(configDir(), 'proxy.log');
}

/**
 * The port the proxy must bind. The IDE's language server is pointed at a fixed
 * URL, so this is not negotiable at runtime — see startProxy().
 */
export function proxyPortSetting(): number {
  const raw = process.env.ANTIGRAVITY_PROXY_PORT;
  if (!raw) return 50999;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`ANTIGRAVITY_PROXY_PORT must be a port number 1-65535, got "${raw}"`);
  }
  return parsed;
}

/**
 * Port for the web console. Unlike the proxy port this one is free to change:
 * nothing but a browser talks to it.
 */
export function webUiPortSetting(): number {
  const raw = process.env.ANTIGRAVITY_UI_PORT;
  if (!raw) return 50998;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`ANTIGRAVITY_UI_PORT must be a port number 1-65535, got "${raw}"`);
  }
  return parsed;
}

/** Creates the config directory if absent. Safe to call repeatedly. */
export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
