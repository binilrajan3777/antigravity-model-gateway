/**
 * Tests for the IDE settings toggle.
 *
 * The bar is high here: this module writes to the user's real settings.json, and
 * a bad write degrades their whole IDE. Comment preservation and the refusal to
 * write invalid JSON are the properties that matter most.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripJsonComments, readState, enableRouting, disableRouting, SETTING_KEY } from '../ideSettings';

let dir: string;
let settingsPath: string;

function write(content: string): void {
  fs.writeFileSync(settingsPath, content, 'utf-8');
}
function read(): string {
  return fs.readFileSync(settingsPath, 'utf-8');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ide-'));
  settingsPath = path.join(dir, 'settings.json');
  process.env.ANTIGRAVITY_IDE_SETTINGS = settingsPath;
});

afterEach(() => {
  delete process.env.ANTIGRAVITY_IDE_SETTINGS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('stripJsonComments', () => {
  it('removes line comments', () => {
    expect(stripJsonComments('{\n // hi\n "a": 1\n}')).not.toContain('hi');
  });

  it('removes block comments', () => {
    expect(stripJsonComments('{ /* gone */ "a": 1 }')).not.toContain('gone');
  });

  it('leaves // inside a string alone', () => {
    // The whole point: the value we manage is a URL containing "//".
    const input = '{ "url": "http://localhost:50999" }';
    expect(JSON.parse(stripJsonComments(input)).url).toBe('http://localhost:50999');
  });

  it('handles an escaped quote before a comment marker', () => {
    const input = '{ "a": "say \\"hi\\"" /* c */ }';
    expect(JSON.parse(stripJsonComments(input)).a).toBe('say "hi"');
  });
});

describe('readState', () => {
  it('reports direct routing when the file has no setting', () => {
    write('{\n  "editor.fontSize": 13\n}');
    const state = readState();
    expect(state.found).toBe(true);
    expect(state.routing).toBe('direct');
    expect(state.url).toBeNull();
  });

  it('reports proxy routing for an active line', () => {
    write(`{\n  "${SETTING_KEY}": "http://127.0.0.1:50999"\n}`);
    const state = readState();
    expect(state.routing).toBe('proxy');
    expect(state.url).toBe('http://127.0.0.1:50999');
  });

  it('recognises a commented-out line and keeps its url', () => {
    write(`{\n  // "${SETTING_KEY}": "http://127.0.0.1:50999",\n  "a": 1\n}`);
    const state = readState();
    expect(state.routing).toBe('direct');
    expect(state.commented).toBe(true);
    expect(state.url).toBe('http://127.0.0.1:50999');
  });

  it('reports not-found when no file exists', () => {
    process.env.ANTIGRAVITY_IDE_SETTINGS = path.join(dir, 'missing.json');
    expect(readState().found).toBe(false);
  });
});

describe('enableRouting', () => {
  it('inserts the setting when absent, adding the needed comma', () => {
    write('{\n  "editor.fontSize": 13\n}');
    const result = enableRouting('http://127.0.0.1:50999');

    expect(result.ok).toBe(true);
    expect(result.state.routing).toBe('proxy');
    expect(read()).toContain(`"${SETTING_KEY}": "http://127.0.0.1:50999"`);
    // Must still parse — the comma insertion is the fragile part.
    expect(() => JSON.parse(stripJsonComments(read()))).not.toThrow();
    expect(JSON.parse(stripJsonComments(read()))['editor.fontSize']).toBe(13);
  });

  it('uncomments an existing commented line', () => {
    write(`{\n  "a": 1,\n  // "${SETTING_KEY}": "http://127.0.0.1:50999"\n}`);
    expect(enableRouting('http://127.0.0.1:50999').ok).toBe(true);
    expect(readState().routing).toBe('proxy');
    expect(read()).not.toMatch(new RegExp(`//\\s*"${SETTING_KEY}"`));
  });

  it('rewrites a stale url in place', () => {
    write(`{\n  "${SETTING_KEY}": "http://localhost:1234"\n}`);
    enableRouting('http://127.0.0.1:50999');
    expect(readState().url).toBe('http://127.0.0.1:50999');
  });

  it('preserves unrelated comments elsewhere in the file', () => {
    write('{\n  // keep me\n  "a": 1\n}');
    enableRouting('http://127.0.0.1:50999');
    expect(read()).toContain('// keep me');
  });

  it('writes a backup before changing anything', () => {
    write('{\n  "a": 1\n}');
    enableRouting('http://127.0.0.1:50999');
    expect(fs.existsSync(settingsPath + '.antigravity-bak')).toBe(true);
    expect(fs.readFileSync(settingsPath + '.antigravity-bak', 'utf-8')).toContain('"a": 1');
  });

  it('handles an empty object', () => {
    write('{}');
    expect(enableRouting('http://127.0.0.1:50999').ok).toBe(true);
    expect(JSON.parse(stripJsonComments(read()))[SETTING_KEY]).toBe('http://127.0.0.1:50999');
  });

  it('handles a single-line object that already has entries', () => {
    write('{"editor.fontSize": 13}');
    expect(enableRouting('http://127.0.0.1:50999').ok).toBe(true);
    const parsed = JSON.parse(stripJsonComments(read()));
    expect(parsed['editor.fontSize']).toBe(13);
    expect(parsed[SETTING_KEY]).toBe('http://127.0.0.1:50999');
  });

  it('puts the comma on the value line, not after a trailing comment', () => {
    write('{\n  "a": 1\n  // trailing note\n}');
    expect(enableRouting('http://127.0.0.1:50999').ok).toBe(true);
    expect(read()).toContain('// trailing note');
    expect(JSON.parse(stripJsonComments(read()).replace(/,(\s*[}\]])/g, '$1')).a).toBe(1);
  });

  it('reports failure instead of writing when no file is found', () => {
    process.env.ANTIGRAVITY_IDE_SETTINGS = path.join(dir, 'nope.json');
    const result = enableRouting('http://127.0.0.1:50999');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no ide settings/i);
  });

  it('preserves CRLF line endings', () => {
    write('{\r\n  "a": 1\r\n}');
    enableRouting('http://127.0.0.1:50999');
    expect(read()).toContain('\r\n');
  });
});

describe('disableRouting', () => {
  it('comments the line out and keeps the url for later', () => {
    write(`{\n  "${SETTING_KEY}": "http://127.0.0.1:50999"\n}`);
    const result = disableRouting();

    expect(result.ok).toBe(true);
    expect(result.state.routing).toBe('direct');
    expect(result.state.url).toBe('http://127.0.0.1:50999');
    expect(read()).toMatch(new RegExp(`//\\s*"${SETTING_KEY}"`));
  });

  it('leaves the file valid JSONC after disabling a middle entry', () => {
    write(`{\n  "a": 1,\n  "${SETTING_KEY}": "http://127.0.0.1:50999",\n  "b": 2\n}`);
    disableRouting();
    const parsed = JSON.parse(stripJsonComments(read()).replace(/,(\s*[}\]])/g, '$1'));
    expect(parsed).toEqual({ a: 1, b: 2 });
  });

  it('is a no-op when already direct', () => {
    write('{\n  "a": 1\n}');
    const result = disableRouting();
    expect(result.ok).toBe(true);
    expect(read()).toBe('{\n  "a": 1\n}');
  });

  it('round-trips: enable, disable, enable', () => {
    write('{\n  "editor.fontSize": 13\n}');
    enableRouting('http://127.0.0.1:50999');
    expect(readState().routing).toBe('proxy');
    disableRouting();
    expect(readState().routing).toBe('direct');
    enableRouting('http://127.0.0.1:50999');
    expect(readState().routing).toBe('proxy');
    expect(JSON.parse(stripJsonComments(read()))['editor.fontSize']).toBe(13);
  });
});
