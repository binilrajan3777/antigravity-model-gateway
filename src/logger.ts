/**
 * Minimal logger — the pure-Node replacement for `electron-log`.
 *
 * Starts as a no-op sink. Nothing is printed or written until enableLogging()
 * is called, which the CLI does at startup. That keeps `import log from
 * './logger'` free of side effects, so unit tests importing the translators
 * stay silent and never touch the filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logFilePath } from './config';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** One rotation only: proxy.log -> proxy.log.1 once it passes this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

interface LoggerState {
  enabled: boolean;
  level: LogLevel;
  toConsole: boolean;
  filePath: string | null;
}

const state: LoggerState = {
  enabled: false,
  level: 'info',
  toConsole: false,
  filePath: null,
};

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  const candidate = (raw || '').toLowerCase();
  return candidate in LEVEL_ORDER ? (candidate as LogLevel) : fallback;
}

/** Objects and Errors both have to survive being logged. */
function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function rotateIfNeeded(filePath: string): void {
  try {
    const { size } = fs.statSync(filePath);
    if (size < MAX_LOG_BYTES) return;
    fs.renameSync(filePath, filePath + '.1');
  } catch {
    // No file yet, or the rename lost a race. Either way, keep going.
  }
}

function emit(level: LogLevel, args: unknown[]): void {
  if (!state.enabled) return;
  if (LEVEL_ORDER[level] > LEVEL_ORDER[state.level]) return;

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${format(args)}`;

  if (state.toConsole) {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  if (state.filePath) {
    try {
      fs.appendFileSync(state.filePath, line + '\n');
    } catch {
      // Logging must never take the proxy down.
    }
  }
}

export interface LoggingOptions {
  /** Default: ANTIGRAVITY_LOG_LEVEL, else 'info'. */
  level?: LogLevel;
  /** Default: true. */
  console?: boolean;
  /** Default: true. Pass false to log to the console only. */
  file?: boolean;
}

/**
 * Turns the logger on. Called once by the CLI; tests leave it off.
 * Returns the resolved log file path, or null when file logging is disabled.
 */
export function enableLogging(options: LoggingOptions = {}): string | null {
  state.enabled = true;
  state.level = options.level ?? parseLevel(process.env.ANTIGRAVITY_LOG_LEVEL, 'info');
  state.toConsole = options.console ?? true;

  if (options.file === false) {
    state.filePath = null;
    return null;
  }

  const target = logFilePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfNeeded(target);
    state.filePath = target;
  } catch (err) {
    state.filePath = null;
    // The console sink is still live, so say why the file one is not.
    if (state.toConsole) console.warn(`[Logger] File logging disabled (${(err as Error).message})`);
  }
  return state.filePath;
}

export const info = (...args: unknown[]): void => emit('info', args);
export const warn = (...args: unknown[]): void => emit('warn', args);
export const error = (...args: unknown[]): void => emit('error', args);
export const debug = (...args: unknown[]): void => emit('debug', args);

export default { info, warn, error, debug };
