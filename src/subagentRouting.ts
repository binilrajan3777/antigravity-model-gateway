/**
 * Routing for Antigravity's internal subagents.
 *
 * Some steps run on a model the IDE picks for itself rather than the one in the
 * dropdown. Page inspection is the visible case: it dispatches
 * `requestType: browser_subagent` against `gemini-3-flash` no matter which model
 * the user selected. Those are *managed Google* models, so with
 * `jetski.cloudCodeUrl` pointed at this proxy they come back
 * `429 RESOURCE_EXHAUSTED` and the browser tool dies mid-task — while the custom
 * model driving the conversation is working fine.
 *
 * Pointing those request types at a custom model keeps the tool alive. This is
 * strictly opt-in: with no `subagentModel` configured, resolveSubagentModel()
 * returns null and every such request forwards to Google exactly as before.
 *
 * Deliberately narrow by default. `tab` and `tab_jump` (inline completion) are
 * high-volume and currently succeed, and `agent` is the model the user actually
 * chose — silently rerouting any of those would spend money on the user's
 * gateway for work they did not ask to move.
 */

import * as fs from 'fs';
import { modelSlug, modelPlaceholderId } from './proxy/modelUtils';

/**
 * Only the request types that are both IDE-chosen and currently failing.
 *
 * `generate_commit_message` belongs here for the same reason as
 * `browser_subagent`: the IDE runs it on `gemini-3.1-flash-lite` regardless of
 * the selected model, so it 429s for as long as the proxy is in the path.
 */
export const DEFAULT_SUBAGENT_REQUEST_TYPES = ['browser_subagent', 'generate_commit_message'];

export interface SubagentConfig {
  /** Model identifier to route to, or null when the feature is off. */
  modelName: string | null;
  /** Request types to intercept. */
  requestTypes: string[];
}

interface MatchableModel {
  name?: string;
  displayName?: string;
  externalModelName?: string;
}

/**
 * Reads the top-level `subagentModel` / `subagentRequestTypes` keys that sit
 * alongside `models` in custom_models.json.
 *
 * Environment variables win, so a routing problem can be tested without editing
 * the config: ANTIGRAVITY_SUBAGENT_MODEL, ANTIGRAVITY_SUBAGENT_REQUEST_TYPES
 * (comma-separated).
 */
export function parseSubagentConfig(
  parsed: unknown,
  env: Record<string, string | undefined> = process.env,
): SubagentConfig {
  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;

  const envModel = env.ANTIGRAVITY_SUBAGENT_MODEL?.trim();
  const fileModel = typeof raw.subagentModel === 'string' ? raw.subagentModel.trim() : '';
  const modelName = envModel || fileModel || null;

  const envTypes = env.ANTIGRAVITY_SUBAGENT_REQUEST_TYPES?.split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const fileTypes = Array.isArray(raw.subagentRequestTypes)
    ? raw.subagentRequestTypes.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    : undefined;

  const requestTypes = envTypes?.length ? envTypes : fileTypes?.length ? fileTypes : DEFAULT_SUBAGENT_REQUEST_TYPES;

  return { modelName, requestTypes };
}

/** parseSubagentConfig() against the config file, tolerant of a missing or broken file. */
export function readSubagentConfig(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): SubagentConfig {
  try {
    if (!fs.existsSync(filePath)) return parseSubagentConfig({}, env);
    return parseSubagentConfig(JSON.parse(fs.readFileSync(filePath, 'utf-8')), env);
  } catch {
    // A malformed file is already reported by loadCustomModels(); staying quiet
    // here keeps one syntax error from producing two identical log lines.
    return parseSubagentConfig({}, env);
  }
}

/**
 * The same identifier forms the proxy accepts everywhere else, so `subagentModel`
 * can be written as the `models/…` name, the `custom-…` slug, the placeholder id
 * or the dropdown label.
 */
export function matchesIdentifier(model: MatchableModel, identifier: string): boolean {
  return (
    model.name === identifier ||
    model.displayName === identifier ||
    modelSlug(model) === identifier ||
    modelPlaceholderId(model) === identifier
  );
}

/**
 * Picks the model that should serve a subagent request, or null to let it pass
 * through to Google.
 */
export function resolveSubagentModel<T extends MatchableModel>(
  models: T[],
  config: SubagentConfig,
  requestType: unknown,
): T | null {
  if (!config.modelName) return null;
  if (typeof requestType !== 'string' || !config.requestTypes.includes(requestType)) return null;

  return models.find((m) => matchesIdentifier(m, config.modelName as string)) || null;
}
