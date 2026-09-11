import { describe, it, expect } from 'vitest';
import {
  parseSubagentConfig,
  resolveSubagentModel,
  matchesIdentifier,
  DEFAULT_SUBAGENT_REQUEST_TYPES,
} from '../subagentRouting';

const MODELS = [
  { name: 'models/gpt-5.6', displayName: 'Sol', externalModelName: 'gpt-5.6-sol' },
  { name: 'models/gpt-5.6-luna', displayName: 'GPT-5.6 Luna', externalModelName: 'gpt-5.6-luna' },
];

// The request the IDE sends when it inspects a page — always a Google model,
// regardless of what the user picked in the dropdown.
const BROWSER = 'browser_subagent';

describe('parseSubagentConfig', () => {
  it('is off when nothing is configured', () => {
    expect(parseSubagentConfig({}, {}).modelName).toBeNull();
  });

  it('reads the model from the config file', () => {
    expect(parseSubagentConfig({ subagentModel: 'models/gpt-5.6' }, {}).modelName).toBe('models/gpt-5.6');
  });

  it('defaults to the IDE-chosen request types that fail through the proxy', () => {
    expect(parseSubagentConfig({}, {}).requestTypes).toEqual(DEFAULT_SUBAGENT_REQUEST_TYPES);
    expect(parseSubagentConfig({}, {}).requestTypes).toEqual(['browser_subagent', 'generate_commit_message']);
  });

  it('lets the env override the file', () => {
    const config = parseSubagentConfig(
      { subagentModel: 'models/from-file' },
      { ANTIGRAVITY_SUBAGENT_MODEL: 'models/from-env' },
    );
    expect(config.modelName).toBe('models/from-env');
  });

  it('accepts custom request types from either source', () => {
    expect(parseSubagentConfig({ subagentRequestTypes: ['checkpoint'] }, {}).requestTypes).toEqual(['checkpoint']);
    expect(
      parseSubagentConfig({}, { ANTIGRAVITY_SUBAGENT_REQUEST_TYPES: 'browser_subagent, checkpoint' }).requestTypes,
    ).toEqual(['browser_subagent', 'checkpoint']);
  });

  it('ignores empty and malformed values rather than disabling the defaults', () => {
    expect(parseSubagentConfig({ subagentModel: '   ' }, {}).modelName).toBeNull();
    expect(parseSubagentConfig({ subagentRequestTypes: [] }, {}).requestTypes).toEqual(DEFAULT_SUBAGENT_REQUEST_TYPES);
    expect(parseSubagentConfig({ subagentRequestTypes: 'nope' }, {}).requestTypes).toEqual(
      DEFAULT_SUBAGENT_REQUEST_TYPES,
    );
    expect(parseSubagentConfig(null, {}).modelName).toBeNull();
  });
});

describe('matchesIdentifier', () => {
  it('accepts every identifier form the proxy already understands', () => {
    const model = MODELS[0];
    expect(matchesIdentifier(model, 'models/gpt-5.6')).toBe(true);
    expect(matchesIdentifier(model, 'Sol')).toBe(true);
    expect(matchesIdentifier(model, 'custom-gpt-5-6-sol')).toBe(true);
    expect(matchesIdentifier(model, 'MODEL_PLACEHOLDER_M403')).toBe(true);
    expect(matchesIdentifier(model, 'models/other')).toBe(false);
  });
});

describe('resolveSubagentModel', () => {
  const config = { modelName: 'models/gpt-5.6', requestTypes: [BROWSER] };

  it('reroutes a browser subagent request', () => {
    expect(resolveSubagentModel(MODELS, config, BROWSER)?.displayName).toBe('Sol');
  });

  it('reroutes commit message generation under the defaults', () => {
    const defaults = { modelName: 'models/gpt-5.6', requestTypes: DEFAULT_SUBAGENT_REQUEST_TYPES };
    expect(resolveSubagentModel(MODELS, defaults, 'generate_commit_message')?.displayName).toBe('Sol');
  });

  it('leaves the request types it was not asked to handle alone', () => {
    // The user's own dropdown choice must never be silently rerouted, and
    // inline completion is high-volume and already works.
    expect(resolveSubagentModel(MODELS, config, 'agent')).toBeNull();
    expect(resolveSubagentModel(MODELS, config, 'tab')).toBeNull();
    expect(resolveSubagentModel(MODELS, config, 'checkpoint')).toBeNull();
  });

  it('passes through when the feature is off', () => {
    expect(resolveSubagentModel(MODELS, { modelName: null, requestTypes: [BROWSER] }, BROWSER)).toBeNull();
  });

  it('passes through when the configured model does not exist', () => {
    const missing = { modelName: 'models/deleted', requestTypes: [BROWSER] };
    expect(resolveSubagentModel(MODELS, missing, BROWSER)).toBeNull();
  });

  it('passes through when requestType is absent or not a string', () => {
    expect(resolveSubagentModel(MODELS, config, undefined)).toBeNull();
    expect(resolveSubagentModel(MODELS, config, 42)).toBeNull();
  });

  it('resolves by slug and by display name too', () => {
    expect(resolveSubagentModel(MODELS, { modelName: 'custom-gpt-5-6-luna', requestTypes: [BROWSER] }, BROWSER)?.name)
      .toBe('models/gpt-5.6-luna');
    expect(resolveSubagentModel(MODELS, { modelName: 'Sol', requestTypes: [BROWSER] }, BROWSER)?.name).toBe(
      'models/gpt-5.6',
    );
  });
});
