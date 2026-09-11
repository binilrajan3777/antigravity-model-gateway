/**
 * Tests for the model store the web UI writes through.
 *
 * The load-bearing behaviours: API keys never appear in a view, the documented
 * traps are actually detected, and a write cannot silently hit the wrong row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  snapshot,
  createModel,
  updateModel,
  deleteModel,
  getRawModel,
  findIssues,
  exportConfig,
  importConfig,
  setSubagentModel,
} from '../modelStore';

let dir: string;
let modelsPath: string;

const OLLAMA = {
  name: 'models/qwen',
  provider: 'ollama',
  apiUrl: 'http://localhost:11434/v1/chat/completions',
  displayName: 'Qwen (local)',
  externalModelName: 'qwen3.5:latest',
};

function seed(models: unknown[]): void {
  fs.writeFileSync(modelsPath, JSON.stringify({ models }, null, 2), 'utf-8');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-models-'));
  modelsPath = path.join(dir, 'custom_models.json');
  process.env.ANTIGRAVITY_MODELS_FILE = modelsPath;
});

afterEach(() => {
  delete process.env.ANTIGRAVITY_MODELS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('snapshot', () => {
  it('is empty when no config file exists', () => {
    const snap = snapshot();
    expect(snap.models).toEqual([]);
    expect(snap.issues).toEqual([]);
  });

  it('never exposes a full API key', () => {
    seed([
      {
        ...OLLAMA,
        provider: 'openai',
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-super-secret-value-1234',
      },
    ]);
    const view = snapshot().models[0];

    expect(JSON.stringify(view)).not.toContain('super-secret');
    expect(view.hasKey).toBe(true);
    expect(view.keyPreview).toBe('sk-s…1234');
  });

  it('reports no key for a keyless local model', () => {
    seed([OLLAMA]);
    const view = snapshot().models[0];
    expect(view.hasKey).toBe(false);
    expect(view.keyPreview).toBeNull();
  });

  it('derives slot, placeholder id and slug', () => {
    seed([OLLAMA]);
    const view = snapshot().models[0];
    expect(view.slot).toBeGreaterThanOrEqual(400);
    expect(view.slot).toBeLessThanOrEqual(599);
    expect(view.placeholderId).toBe(`MODEL_PLACEHOLDER_M${view.slot}`);
    expect(view.slug).toBe('custom-qwen3-5-latest');
  });

  it('throws a clear error on a corrupt config', () => {
    fs.writeFileSync(modelsPath, '{ not json', 'utf-8');
    expect(() => snapshot()).toThrow(/not valid JSON/);
  });
});

describe('findIssues', () => {
  it('flags duplicate names as errors', () => {
    const issues = findIssues([
      { ...OLLAMA, displayName: 'First' },
      { ...OLLAMA, displayName: 'Second' },
    ]);
    const dup = issues.find((i) => i.kind === 'duplicate-name');
    expect(dup?.level).toBe('error');
    expect(dup?.models).toEqual([0, 1]);
  });

  it('flags slot collisions as errors', () => {
    // Identical displayName hashes to the same slot by construction.
    const issues = findIssues([
      { ...OLLAMA, name: 'models/a', displayName: 'Same Label' },
      { ...OLLAMA, name: 'models/b', displayName: 'Same Label' },
    ]);
    expect(issues.some((i) => i.kind === 'slot-collision' && i.level === 'error')).toBe(true);
  });

  it('flags an invalid entry as a warning, since the proxy just skips it', () => {
    const issues = findIssues([{ name: 'models/x', provider: 'not-a-provider', apiUrl: 'https://a.b/v1' }]);
    const invalid = issues.find((i) => i.kind === 'invalid');
    expect(invalid?.level).toBe('warning');
  });

  it('finds nothing wrong with a clean config', () => {
    expect(findIssues([OLLAMA, { ...OLLAMA, name: 'models/other', displayName: 'Other Model' }])).toEqual([]);
  });
});

describe('createModel', () => {
  it('adds a model and persists it', () => {
    const snap = createModel({ ...OLLAMA, keyAction: 'keep' });
    expect(snap.models).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(modelsPath, 'utf-8')).models).toHaveLength(1);
  });

  it('rejects a duplicate name up front', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });
    expect(() => createModel({ ...OLLAMA, keyAction: 'keep' })).toThrow(/already exists/);
  });

  it('rejects an invalid provider', () => {
    expect(() => createModel({ ...OLLAMA, provider: 'bogus', keyAction: 'keep' })).toThrow(/provider/i);
  });

  it('sets and clears the subagent model through the store', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });

    const set = setSubagentModel('models/qwen');
    expect(set.subagentModel).toBe('models/qwen');
    expect(JSON.parse(fs.readFileSync(modelsPath, 'utf-8')).subagentModel).toBe('models/qwen');

    const cleared = setSubagentModel(null);
    expect(cleared.subagentModel).toBeNull();
    expect(JSON.parse(fs.readFileSync(modelsPath, 'utf-8')).subagentModel).toBeUndefined();
  });

  it('refuses a subagent model that does not exist', () => {
    // Falling back to Google silently would look exactly like never having set it.
    createModel({ ...OLLAMA, keyAction: 'keep' });
    expect(() => setSubagentModel('models/nope')).toThrow(/No model matches/);
  });

  it('keeps the subagent setting when a model is edited afterwards', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });
    setSubagentModel('models/qwen');

    updateModel(0, { ...OLLAMA, displayName: 'Renamed', keyAction: 'keep' }, 'models/qwen');

    expect(JSON.parse(fs.readFileSync(modelsPath, 'utf-8')).subagentModel).toBe('models/qwen');
  });

  it('preserves top-level settings that sit beside the model list', () => {
    // A rewrite built from the model list alone would delete these, so editing
    // any model in the console would silently turn subagent routing off.
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({ subagentModel: 'models/qwen', subagentRequestTypes: ['browser_subagent'], models: [] }, null, 2),
      'utf-8',
    );

    createModel({ ...OLLAMA, keyAction: 'keep' });

    const written = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    expect(written.subagentModel).toBe('models/qwen');
    expect(written.subagentRequestTypes).toEqual(['browser_subagent']);
    expect(written.models).toHaveLength(1);
  });

  it('rejects a bare host as apiUrl', () => {
    expect(() => createModel({ ...OLLAMA, apiUrl: 'not-a-url', keyAction: 'keep' })).toThrow(/URL/i);
  });

  it('stores a key obfuscated rather than in plaintext', () => {
    createModel({
      ...OLLAMA,
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      keyAction: 'set',
      apiKey: 'sk-plain-1234',
    });
    const raw = fs.readFileSync(modelsPath, 'utf-8');
    expect(raw).not.toContain('sk-plain-1234');
    expect(raw).toContain('fallback:');
    // ...and reads back correctly for the proxy.
    expect(getRawModel(0).apiKey).toBe('sk-plain-1234');
  });

  it('omits empty optional fields instead of writing blanks', () => {
    createModel({ ...OLLAMA, description: '   ', keyAction: 'keep' });
    const stored = JSON.parse(fs.readFileSync(modelsPath, 'utf-8')).models[0];
    expect(stored).not.toHaveProperty('description');
  });
});

describe('updateModel', () => {
  beforeEach(() => {
    createModel({
      ...OLLAMA,
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      keyAction: 'set',
      apiKey: 'sk-original',
    });
  });

  it("keeps the stored key when keyAction is 'keep'", () => {
    updateModel(
      0,
      {
        ...OLLAMA,
        provider: 'openai',
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        displayName: 'Renamed',
        keyAction: 'keep',
      },
      OLLAMA.name,
    );
    expect(getRawModel(0).apiKey).toBe('sk-original');
    expect(snapshot().models[0].displayName).toBe('Renamed');
  });

  it("replaces the key when keyAction is 'set'", () => {
    updateModel(
      0,
      {
        ...OLLAMA,
        provider: 'openai',
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        keyAction: 'set',
        apiKey: 'sk-new',
      },
      OLLAMA.name,
    );
    expect(getRawModel(0).apiKey).toBe('sk-new');
  });

  it("removes the key when keyAction is 'clear'", () => {
    updateModel(0, { ...OLLAMA, keyAction: 'clear' }, OLLAMA.name);
    expect(getRawModel(0).apiKey).toBeUndefined();
    expect(snapshot().models[0].hasKey).toBe(false);
  });

  it('refuses when the row no longer holds the expected model', () => {
    // Simulates the config changing under an open browser tab.
    expect(() => updateModel(0, { ...OLLAMA, keyAction: 'keep' }, 'models/something-else')).toThrow(/changed/i);
  });

  it('refuses an out-of-range index', () => {
    expect(() => updateModel(9, { ...OLLAMA, keyAction: 'keep' })).toThrow(/no model at position/i);
  });

  it('refuses a name that collides with another entry', () => {
    createModel({ ...OLLAMA, name: 'models/second', displayName: 'Second', keyAction: 'keep' });
    expect(() => updateModel(1, { ...OLLAMA, name: OLLAMA.name, keyAction: 'keep' }, 'models/second')).toThrow(
      /already uses/,
    );
  });
});

describe('deleteModel', () => {
  it('removes the addressed row and backs the file up first', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });
    createModel({ ...OLLAMA, name: 'models/two', displayName: 'Two', keyAction: 'keep' });

    const snap = deleteModel(0, OLLAMA.name);
    expect(snap.models).toHaveLength(1);
    expect(snap.models[0].name).toBe('models/two');
    expect(fs.existsSync(modelsPath + '.bak')).toBe(true);
  });

  it('refuses a stale index', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });
    expect(() => deleteModel(0, 'models/stale')).toThrow(/changed/i);
  });
});

describe('export and import', () => {
  it('strips API keys from an export', () => {
    createModel({
      ...OLLAMA,
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      keyAction: 'set',
      apiKey: 'sk-secret',
    });
    const { models, strippedKeys } = exportConfig();

    expect(strippedKeys).toBe(1);
    expect(JSON.stringify(models)).not.toContain('sk-secret');
    expect(models[0]).not.toHaveProperty('apiKey');
  });

  it('round-trips an export back through import', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });
    const exported = exportConfig();
    const result = importConfig({ models: exported.models });

    expect(result.imported).toBe(1);
    expect(result.snapshot.models[0].name).toBe(OLLAMA.name);
  });

  it('skips invalid entries rather than writing them', () => {
    const result = importConfig({
      models: [OLLAMA, { name: 'models/bad', provider: 'nope', apiUrl: 'https://a.b/v1' }],
    });
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/provider/i);
  });

  it('skips duplicate names within one import', () => {
    const result = importConfig({ models: [OLLAMA, { ...OLLAMA, displayName: 'Dup' }] });
    expect(result.imported).toBe(1);
    expect(result.skipped[0].reason).toMatch(/duplicate/);
  });

  it('rejects a payload with no models array', () => {
    expect(() => importConfig({ nope: true })).toThrow(/models/);
  });

  it('rejects an import where nothing is valid, leaving the config untouched', () => {
    createModel({ ...OLLAMA, keyAction: 'keep' });
    expect(() => importConfig({ models: [{ name: 'x', provider: 'y', apiUrl: 'z' }] })).toThrow(/nothing to import/i);
    expect(snapshot().models).toHaveLength(1);
  });
});
