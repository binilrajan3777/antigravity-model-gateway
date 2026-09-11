/**
 * CRUD over custom_models.json for the web UI.
 *
 * The proxy itself re-reads the file on every request, so a write here takes
 * effect immediately for routing. The IDE only reads its model list at startup,
 * which is why callers should still tell the user to restart it after adding or
 * renaming a model.
 *
 * ## API keys never reach the browser
 *
 * list() returns a masked preview only. Updates carry an explicit `keyAction`
 * so "leave the key alone" is distinguishable from "clear the key" — a plain
 * empty string could mean either, and guessing would silently drop credentials.
 */

import * as fs from 'fs';
import * as path from 'path';
import log from './logger';
import { customModelsPath } from './config';
import * as cryptoStore from './cryptoStore';
import { validateCustomModel } from './schemaValidator';
import { detectModelCapabilities, modelPlaceholderSlot, modelSlug, PLACEHOLDER_RANGE } from './proxy/modelUtils';
import { matchesIdentifier, readSubagentConfig } from './subagentRouting';
import type { CustomModel } from './proxy';

/** Editable fields, as the UI sends them. `apiKey` is handled via keyAction. */
export interface ModelInput {
  name: string;
  provider: string;
  apiUrl: string;
  displayName?: string;
  description?: string;
  externalModelName?: string;
  timeout?: number;
  maxRetries?: number;
  allowUnauthorized?: boolean;
  /** undefined keeps automatic name-based detection. */
  supportsImages?: boolean;
  /** 'keep' leaves the stored key, 'set' uses apiKey, 'clear' removes it. */
  keyAction?: 'keep' | 'set' | 'clear';
  apiKey?: string;
}

/** A model as presented to the UI: no secrets, plus derived facts. */
export interface ModelView {
  index: number;
  name: string;
  provider: string;
  apiUrl: string;
  displayName: string;
  description: string;
  externalModelName: string;
  timeout: number | null;
  maxRetries: number | null;
  allowUnauthorized: boolean;
  /** null when unset, i.e. capability is auto-detected. */
  supportsImages: boolean | null;
  hasKey: boolean;
  /** e.g. "sk-a…f912". Never the full key. */
  keyPreview: string | null;
  slot: number;
  placeholderId: string;
  slug: string;
  capabilities: {
    isThinking: boolean;
    isClaude: boolean;
    supportsImages: boolean;
    maxTokens: number;
    maxOutputTokens: number;
  };
  valid: boolean;
  error: string | null;
}

export type IssueLevel = 'error' | 'warning';

export interface ConfigIssue {
  level: IssueLevel;
  kind: 'invalid' | 'duplicate-name' | 'slot-collision' | 'unreachable-file';
  message: string;
  /** Indices of the models involved. */
  models: number[];
}

export interface StoreSnapshot {
  filePath: string;
  models: ModelView[];
  issues: ConfigIssue[];
  slotsUsed: number;
  slotsTotal: number;
  /** Model serving IDE-chosen subagents, or null when they go to Google. */
  subagentModel: string | null;
  /** Set when ANTIGRAVITY_SUBAGENT_MODEL is overriding the file. */
  subagentEnvOverride: string | null;
  /** Request types currently rerouted, for the UI to name them. */
  subagentRequestTypes: string[];
}

// ─── Reading ──────────────────────────────────────────────────────────────

/** Raw decoded models, keys in plaintext. Never leaves the server. */
function readRaw(): CustomModel[] {
  const filePath = customModelsPath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { models?: CustomModel[] };
    return cryptoStore.decryptModels(parsed.models || []);
  } catch (err) {
    log.error('[ModelStore] Cannot parse custom_models.json:', err);
    throw new Error(`custom_models.json is not valid JSON: ${(err as Error).message}`);
  }
}

/** Top-level config keys other than `models`, so a rewrite preserves them. */
function readTopLevelExtras(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const rest = { ...parsed };
    delete rest.models;
    return rest;
  } catch {
    // readRaw() throws on malformed JSON before any write can reach here.
    return {};
  }
}

/** Shows enough of a key to recognise it, never enough to use it. */
function maskKey(apiKey: string | undefined): string | null {
  if (!apiKey || apiKey === 'none') return null;
  if (apiKey.length <= 8) return '•'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

function toView(model: CustomModel, index: number): ModelView {
  const validation = validateCustomModel(model);
  const caps = detectModelCapabilities(model);

  return {
    index,
    name: model.name || '',
    provider: model.provider || '',
    apiUrl: model.apiUrl || '',
    displayName: model.displayName || '',
    description: model.description || '',
    externalModelName: model.externalModelName || '',
    timeout: model.timeout ?? null,
    maxRetries: model.maxRetries ?? null,
    allowUnauthorized: model.allowUnauthorized === true,
    supportsImages: model.supportsImages === undefined ? null : model.supportsImages,
    hasKey: Boolean(model.apiKey && model.apiKey !== 'none'),
    keyPreview: maskKey(model.apiKey),
    slot: modelPlaceholderSlot(model),
    placeholderId: `MODEL_PLACEHOLDER_M${modelPlaceholderSlot(model)}`,
    slug: modelSlug(model),
    capabilities: {
      isThinking: caps.isThinking,
      isClaude: caps.isClaude,
      supportsImages: caps.supportsImages,
      maxTokens: caps.maxTokens,
      maxOutputTokens: caps.maxOutputTokens,
    },
    valid: validation.valid,
    error: validation.error ?? null,
  };
}

/**
 * The documented traps, detected rather than described.
 *
 * Duplicate `name` is an error because model lookup returns the first match, so
 * one entry silently receives the other's traffic. A slot collision is an error
 * for the same reason at the dropdown level. Invalid entries are warnings here:
 * the proxy skips them, so the rest of the config still works.
 */
export function findIssues(models: CustomModel[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const byName = new Map<string, number[]>();
  const bySlot = new Map<number, number[]>();

  models.forEach((model, index) => {
    const validation = validateCustomModel(model);
    if (!validation.valid) {
      issues.push({
        level: 'warning',
        kind: 'invalid',
        message: `"${model.displayName || model.name || `entry ${index + 1}`}" is invalid and will be skipped: ${validation.error}`,
        models: [index],
      });
    }

    const name = model.name || '';
    if (name) byName.set(name, [...(byName.get(name) || []), index]);

    const slot = modelPlaceholderSlot(model);
    bySlot.set(slot, [...(bySlot.get(slot) || []), index]);
  });

  for (const [name, indices] of byName) {
    if (indices.length > 1) {
      const labels = indices.map((i) => models[i].displayName || name).join('" and "');
      issues.push({
        level: 'error',
        kind: 'duplicate-name',
        message: `"${labels}" share the name "${name}". Lookup returns the first match, so one can silently receive the other's traffic. Give each a unique name.`,
        models: indices,
      });
    }
  }

  for (const [slot, indices] of bySlot) {
    if (indices.length > 1) {
      const labels = indices.map((i) => models[i].displayName || models[i].name).join('" and "');
      issues.push({
        level: 'error',
        kind: 'slot-collision',
        message: `"${labels}" both hash to dropdown slot M${slot}. One of them will not appear in the IDE. Rename a displayName to move it.`,
        models: indices,
      });
    }
  }

  return issues;
}

/** Everything the UI needs to render the model list. */
export function snapshot(): StoreSnapshot {
  const models = readRaw();
  const subagent = readSubagentConfig(customModelsPath());
  const envOverride = process.env.ANTIGRAVITY_SUBAGENT_MODEL?.trim() || null;

  return {
    filePath: customModelsPath(),
    models: models.map(toView),
    issues: findIssues(models),
    slotsUsed: new Set(models.map(modelPlaceholderSlot)).size,
    slotsTotal: PLACEHOLDER_RANGE,
    subagentModel: subagent.modelName,
    subagentEnvOverride: envOverride,
    subagentRequestTypes: subagent.requestTypes,
  };
}

/**
 * Points IDE-chosen subagents at a model, or passes them through to Google when
 * given null.
 *
 * Rejecting an unknown identifier here rather than at request time matters: a
 * subagent that silently falls back to Google is exactly the failure this
 * setting exists to prevent, and it would look identical to not having set it.
 */
export function setSubagentModel(identifier: string | null): StoreSnapshot {
  const models = readRaw();
  const target = identifier?.trim() || null;

  if (target && !models.some((m) => matchesIdentifier(m, target))) {
    throw new Error(`No model matches "${target}". Use its name, slug, placeholder id or display name.`);
  }

  writeRaw(models, { subagentModel: target ?? undefined });
  log.info(target ? `[ModelStore] Subagent requests now routed to "${target}"` : '[ModelStore] Subagent routing off');

  return snapshot();
}

// ─── Writing ──────────────────────────────────────────────────────────────

/**
 * Writes the list back, re-encoding keys. A backup is taken first, and the
 * write goes to a temp file then gets renamed so an interrupted write cannot
 * leave a truncated config behind.
 */
function writeRaw(models: CustomModel[], settings?: Record<string, unknown>): void {
  const filePath = customModelsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (fs.existsSync(filePath)) cryptoStore.backupFile(filePath);

  // encryptModels only touches entries not already marked encrypted.
  const encoded = cryptoStore.encryptModels(models.map((m) => ({ ...m, encrypted: false })));
  // Everything except `models` is carried across untouched. Rebuilding the file
  // from the model list alone would delete sibling settings — subagentModel
  // among them — the first time anyone edited a model in the console.
  // `settings` patches those; an undefined value drops the key via stringify.
  const body = JSON.stringify({ ...readTopLevelExtras(filePath), ...settings, models: encoded }, null, 2);

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, body, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

/** Drops UI-only and empty fields so the file stays clean. */
function applyInput(base: CustomModel | null, input: ModelInput): CustomModel {
  const next: CustomModel = {
    name: input.name.trim(),
    provider: input.provider.trim(),
    apiUrl: input.apiUrl.trim(),
  };

  const optionalText: Array<keyof ModelInput & keyof CustomModel> = ['displayName', 'description', 'externalModelName'];
  for (const field of optionalText) {
    const value = (input[field] as string | undefined)?.trim();
    if (value) (next[field] as string) = value;
  }

  if (typeof input.timeout === 'number' && input.timeout > 0) next.timeout = input.timeout;
  if (typeof input.maxRetries === 'number' && input.maxRetries >= 0) next.maxRetries = input.maxRetries;
  if (input.allowUnauthorized === true) next.allowUnauthorized = true;
  if (typeof input.supportsImages === 'boolean') next.supportsImages = input.supportsImages;

  const action = input.keyAction ?? (input.apiKey !== undefined ? 'set' : 'keep');
  if (action === 'set' && input.apiKey) {
    next.apiKey = input.apiKey.trim();
  } else if (action === 'keep' && base?.apiKey) {
    next.apiKey = base.apiKey;
  }
  // 'clear' simply omits apiKey.

  return next;
}

function assertValid(model: CustomModel): void {
  const validation = validateCustomModel(model);
  if (!validation.valid) throw new Error(validation.error || 'Invalid model');
}

/**
 * Guards against editing the wrong row when the file changed underneath us —
 * the UI sends the name it believes lives at that index.
 */
function resolveIndex(models: CustomModel[], index: number, expectedName?: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= models.length) {
    throw new Error(`No model at position ${index + 1} — the config may have changed. Reload the page.`);
  }
  if (expectedName !== undefined && models[index].name !== expectedName) {
    throw new Error('The config changed since this page loaded. Reload and try again.');
  }
  return index;
}

export function createModel(input: ModelInput): StoreSnapshot {
  const models = readRaw();
  const model = applyInput(null, input);
  assertValid(model);

  if (models.some((m) => m.name === model.name)) {
    throw new Error(`A model named "${model.name}" already exists. Names must be unique.`);
  }

  models.push(model);
  writeRaw(models);
  log.info(`[ModelStore] Added model "${model.displayName || model.name}"`);
  return snapshot();
}

export function updateModel(index: number, input: ModelInput, expectedName?: string): StoreSnapshot {
  const models = readRaw();
  const target = resolveIndex(models, index, expectedName);
  const model = applyInput(models[target], input);
  assertValid(model);

  if (models.some((m, i) => i !== target && m.name === model.name)) {
    throw new Error(`Another model already uses the name "${model.name}". Names must be unique.`);
  }

  models[target] = model;
  writeRaw(models);
  log.info(`[ModelStore] Updated model "${model.displayName || model.name}"`);
  return snapshot();
}

export function deleteModel(index: number, expectedName?: string): StoreSnapshot {
  const models = readRaw();
  const target = resolveIndex(models, index, expectedName);
  const [removed] = models.splice(target, 1);
  writeRaw(models);
  log.info(`[ModelStore] Deleted model "${removed.displayName || removed.name}"`);
  return snapshot();
}

/** Full model including its key. Server-side only — used by the connection test. */
export function getRawModel(index: number, expectedName?: string): CustomModel {
  const models = readRaw();
  return models[resolveIndex(models, index, expectedName)];
}

// ─── Import / export ──────────────────────────────────────────────────────

/**
 * Exportable config with every API key removed, so it is safe to share or
 * commit. Importing it back leaves those models keyless until you re-enter them.
 */
export function exportConfig(): { models: CustomModel[]; strippedKeys: number } {
  const models = readRaw();
  let strippedKeys = 0;

  const cleaned = models.map((model) => {
    const copy: CustomModel = { ...model };
    delete copy.encrypted;
    delete copy._slug;
    if (copy.apiKey && copy.apiKey !== 'none') {
      strippedKeys++;
      delete copy.apiKey;
    }
    return copy;
  });

  return { models: cleaned, strippedKeys };
}

export interface ImportResult {
  imported: number;
  skipped: Array<{ name: string; reason: string }>;
  snapshot: StoreSnapshot;
}

/**
 * Replaces the model list from an uploaded config. Invalid entries are reported
 * rather than written, so a bad file cannot poison the config.
 */
export function importConfig(payload: unknown): ImportResult {
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) {
    throw new Error('Expected an object with a "models" array.');
  }

  const accepted: CustomModel[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const entry of models as CustomModel[]) {
    const label = entry?.displayName || entry?.name || '(unnamed)';
    const validation = validateCustomModel(entry);
    if (!validation.valid) {
      skipped.push({ name: label, reason: validation.error || 'invalid' });
      continue;
    }
    if (seen.has(entry.name)) {
      skipped.push({ name: label, reason: `duplicate name "${entry.name}"` });
      continue;
    }
    seen.add(entry.name);

    // Decode any keys the file arrived with, so writeRaw re-encodes consistently.
    const decoded = cryptoStore.decryptModels([{ ...entry, encrypted: true }])[0];
    accepted.push({ ...decoded, encrypted: false });
  }

  if (accepted.length === 0) {
    throw new Error('Nothing to import — no valid models in that file.');
  }

  writeRaw(accepted);
  log.info(`[ModelStore] Imported ${accepted.length} model(s), skipped ${skipped.length}`);
  return { imported: accepted.length, skipped, snapshot: snapshot() };
}
