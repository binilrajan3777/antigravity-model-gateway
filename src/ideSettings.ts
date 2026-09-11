/**
 * Reads and toggles the IDE's `jetski.cloudCodeUrl` setting — the switch that
 * decides whether Antigravity routes through this proxy or talks to Google
 * directly.
 *
 * ## Why the editing is surgical
 *
 * settings.json is JSONC: it may contain `//` comments, and the IDE preserves
 * them. Parsing and re-serialising would silently delete every comment in the
 * user's file, so instead we operate on the single line we care about and leave
 * every other byte untouched. Disabling comments the line out rather than
 * deleting it, which keeps the URL around for re-enabling.
 *
 * Every write is preceded by a backup and followed by a parse check; if the
 * result is not valid JSONC the original is restored. A broken settings.json
 * degrades the whole IDE, so that guarantee matters more than the feature.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from './logger';

/** The setting the IDE passes to its language server as --cloud_code_endpoint. */
export const SETTING_KEY = 'jetski.cloudCodeUrl';

export type IdeRouting = 'proxy' | 'direct';

export interface IdeSettingsState {
  /** Whether a settings.json was located at all. */
  found: boolean;
  /** Absolute path to the file, when found. */
  filePath: string | null;
  /** Every candidate that exists on disk — some installs have more than one. */
  candidates: string[];
  /** 'proxy' when an active setting line is present, else 'direct'. */
  routing: IdeRouting;
  /** The URL currently configured, whether the line is active or commented. */
  url: string | null;
  /** True when the line exists but is commented out. */
  commented: boolean;
}

/**
 * Candidate config directories, in preference order, for the current platform.
 *
 * The IDE has shipped under more than one product name, so several directories
 * can exist side by side; pickPrimary() decides between them.
 */
function candidateDirs(): string[] {
  const home = os.homedir();
  const productNames = ['Antigravity IDE', 'Antigravity'];

  let roots: string[];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots = [appData];
  } else if (process.platform === 'darwin') {
    roots = [path.join(home, 'Library', 'Application Support')];
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    roots = [xdg];
  }

  const dirs: string[] = [];
  for (const root of roots) {
    for (const product of productNames) {
      dirs.push(path.join(root, product, 'User'));
    }
  }
  return dirs;
}

/** Every settings.json that actually exists, in preference order. */
export function findSettingsFiles(): string[] {
  const override = process.env.ANTIGRAVITY_IDE_SETTINGS;
  if (override) return fs.existsSync(override) ? [override] : [];

  return candidateDirs()
    .map((dir) => path.join(dir, 'settings.json'))
    .filter((file) => fs.existsSync(file));
}

/**
 * Chooses between multiple candidates: prefer one that already mentions the
 * setting, then one with any `jetski.*` key, then the first that exists.
 */
function pickPrimary(files: string[]): string | null {
  if (files.length === 0) return null;

  for (const file of files) {
    try {
      if (readLine(fs.readFileSync(file, 'utf-8')).lineIndex !== -1) return file;
    } catch {
      /* unreadable — fall through to the next candidate */
    }
  }
  for (const file of files) {
    try {
      if (fs.readFileSync(file, 'utf-8').includes('jetski.')) return file;
    } catch {
      /* ignore */
    }
  }
  return files[0];
}

interface LineMatch {
  lineIndex: number;
  commented: boolean;
  url: string | null;
  /** Whether the original line ended with a comma. */
  trailingComma: boolean;
  indent: string;
}

/** Locates the setting line, whether it is active or commented out. */
function readLine(content: string): LineMatch {
  const lines = content.split(/\r?\n/);
  // Matches:  "jetski.cloudCodeUrl": "http://..."   with optional // and comma
  const pattern = new RegExp(`^(\\s*)(//\\s*)?"${SETTING_KEY}"\\s*:\\s*"([^"]*)"\\s*(,?)`);

  for (let i = 0; i < lines.length; i++) {
    const m = pattern.exec(lines[i]);
    if (m) {
      return {
        lineIndex: i,
        commented: Boolean(m[2]),
        url: m[3],
        trailingComma: m[4] === ',',
        indent: m[1],
      };
    }
  }
  return { lineIndex: -1, commented: false, url: null, trailingComma: false, indent: '  ' };
}

/**
 * Strips JSONC comments so the result can be handed to JSON.parse for a
 * validity check. String-aware, so a `//` inside a URL is not treated as a
 * comment — which is exactly the case we deal with here.
 */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Removes trailing commas, which JSONC allows and JSON.parse does not. */
function removeTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, '$1');
}

/** True when `content` is valid JSONC describing an object. */
function isParseable(content: string): boolean {
  try {
    const parsed = JSON.parse(removeTrailingCommas(stripJsonComments(content)) || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Current state of the IDE routing switch. */
export function readState(): IdeSettingsState {
  const candidates = findSettingsFiles();
  const filePath = pickPrimary(candidates);

  if (!filePath) {
    return { found: false, filePath: null, candidates, routing: 'direct', url: null, commented: false };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    log.error(`[IdeSettings] Cannot read ${filePath}:`, err);
    return { found: false, filePath, candidates, routing: 'direct', url: null, commented: false };
  }

  const match = readLine(content);
  const active = match.lineIndex !== -1 && !match.commented;

  return {
    found: true,
    filePath,
    candidates,
    routing: active ? 'proxy' : 'direct',
    url: match.url,
    commented: match.lineIndex !== -1 && match.commented,
  };
}

export interface WriteResult {
  ok: boolean;
  /** Human-readable outcome, suitable for showing in the UI. */
  message: string;
  state: IdeSettingsState;
}

/**
 * Writes `content` to `filePath`, but only after confirming it still parses.
 * Keeps a one-shot backup at `<file>.antigravity-bak`.
 */
function safeWrite(filePath: string, content: string): { ok: boolean; message: string } {
  if (!isParseable(content)) {
    return { ok: false, message: 'Refused to write: the result would not be valid JSON.' };
  }

  const backupPath = filePath + '.antigravity-bak';
  let original: string | null = null;
  try {
    original = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(backupPath, original, 'utf-8');
  } catch (err) {
    return { ok: false, message: `Could not back up settings.json: ${(err as Error).message}` };
  }

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    // Put the original back rather than leaving a half-written file.
    try {
      if (original !== null) fs.writeFileSync(filePath, original, 'utf-8');
    } catch {
      /* the backup file is the last resort */
    }
    return { ok: false, message: `Could not write settings.json: ${(err as Error).message}` };
  }

  return { ok: true, message: `Backup written to ${path.basename(backupPath)}` };
}

/**
 * Points the IDE at `proxyUrl`. Uncomments an existing line, rewrites a stale
 * URL, or inserts the setting when absent.
 */
export function enableRouting(proxyUrl: string): WriteResult {
  const state = readState();
  if (!state.filePath) {
    return {
      ok: false,
      message: 'No IDE settings.json found. Set ANTIGRAVITY_IDE_SETTINGS to its path, or add the setting by hand.',
      state,
    };
  }

  const content = fs.readFileSync(state.filePath, 'utf-8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const match = readLine(content);

  let updated: string;

  if (match.lineIndex !== -1) {
    // The line exists: uncomment it and set the URL, keeping its comma as-is.
    const comma = match.trailingComma ? ',' : '';
    lines[match.lineIndex] = `${match.indent}"${SETTING_KEY}": "${proxyUrl}"${comma}`;
    updated = lines.join(eol);
  } else {
    // Insert before the object's final closing brace. Splitting on the brace
    // character rather than on lines handles a one-line file such as `{}` or
    // `{"a":1}` as well as a conventionally formatted one.
    const closing = content.lastIndexOf('}');
    if (closing === -1) {
      return { ok: false, message: 'settings.json has no closing brace — is it valid JSON?', state };
    }

    let before = content.slice(0, closing);
    const after = content.slice(closing);

    // An empty object needs no separator; anything else needs a comma unless
    // one is already there. Trailing comments must not swallow the comma, so it
    // is appended to the last line that actually holds a value.
    const meaningful = stripJsonComments(before).trimEnd();
    const needsComma = meaningful !== '' && !meaningful.endsWith('{') && !meaningful.endsWith(',');

    if (needsComma) {
      const beforeLines = before.split(/\r?\n/);
      for (let i = beforeLines.length - 1; i >= 0; i--) {
        const trimmed = beforeLines[i].trim();
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        beforeLines[i] = beforeLines[i].replace(/\s*$/, '') + ',';
        break;
      }
      before = beforeLines.join(eol);
    }

    updated = `${before.replace(/\s*$/, '')}${eol}  "${SETTING_KEY}": "${proxyUrl}"${eol}${after.trimStart()}`;
  }

  const result = safeWrite(state.filePath, updated);
  return {
    ok: result.ok,
    message: result.ok ? `IDE routing enabled → ${proxyUrl}. ${result.message}` : result.message,
    state: readState(),
  };
}

/**
 * Comments the setting out so the IDE falls back to Google directly. The URL is
 * preserved in the comment so enabling again restores it.
 */
export function disableRouting(): WriteResult {
  const state = readState();
  if (!state.filePath) {
    return { ok: false, message: 'No IDE settings.json found.', state };
  }
  if (state.routing === 'direct') {
    return { ok: true, message: 'Already routing directly to Google — nothing to change.', state };
  }

  const content = fs.readFileSync(state.filePath, 'utf-8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const match = readLine(content);

  const comma = match.trailingComma ? ',' : '';
  lines[match.lineIndex] = `${match.indent}// "${SETTING_KEY}": "${match.url}"${comma}`;

  // A commented-out last entry can leave the previous line with a dangling
  // comma, which JSONC tolerates but which we avoid producing anyway.
  const result = safeWrite(state.filePath, lines.join(eol));
  return {
    ok: result.ok,
    message: result.ok ? `IDE routing disabled (setting commented out). ${result.message}` : result.message,
    state: readState(),
  };
}
