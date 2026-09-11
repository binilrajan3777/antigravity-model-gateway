/**
 * Runtime validation for custom model configuration entries.
 *
 * loadCustomModels() runs every entry in custom_models.json through
 * validateCustomModel() and skips the ones that fail, so a typo in the config
 * costs you one model rather than the whole proxy.
 *
 * Only `name`, `provider` and `apiUrl` are required. Everything else is
 * optional and validated only when present — this is the authority that
 * CustomModel in proxy.ts mirrors.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** Providers the translator registry knows how to route. */
const VALID_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'custom',
  'openrouter',
  'deepseek',
  'groq',
  'mistral',
  'cerebras',
  'kimi',
  'fireworks',
  'lmstudio',
  'llamacpp',
  'nvidia',
];

/**
 * Validates a single custom model configuration.
 */
export function validateCustomModel(model: unknown): ValidationResult {
  if (!model || typeof model !== 'object') {
    return { valid: false, error: 'Model is null or not an object' };
  }

  const m = model as Record<string, unknown>;
  for (const field of ['name', 'provider', 'apiUrl']) {
    if (!m[field] || typeof m[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  const name = m.name as string;
  if (!name.startsWith('models/') && !name.includes('/')) {
    return { valid: false, error: 'Model name must start with "models/"' };
  }

  const provider = m.provider as string;
  if (!VALID_PROVIDERS.includes(provider)) {
    return {
      valid: false,
      error: `Unsupported provider: ${provider}. Must be one of: ${VALID_PROVIDERS.join(', ')}`,
    };
  }

  const apiUrl = m.apiUrl as string;
  try {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'API URL must use http or https protocol' };
    }
  } catch (e) {
    return { valid: false, error: `Invalid API URL: ${(e as Error).message}` };
  }

  // Optional fields — only checked when supplied.
  if (m.externalModelName && typeof m.externalModelName !== 'string') {
    return { valid: false, error: 'externalModelName must be a string' };
  }
  if (m.displayName && typeof m.displayName !== 'string') {
    return { valid: false, error: 'displayName must be a string' };
  }
  if (m.apiKey && typeof m.apiKey !== 'string') {
    return { valid: false, error: 'apiKey must be a string' };
  }
  if (m.allowUnauthorized !== undefined && typeof m.allowUnauthorized !== 'boolean') {
    return { valid: false, error: 'allowUnauthorized must be a boolean' };
  }
  if (m.supportsImages !== undefined && typeof m.supportsImages !== 'boolean') {
    return { valid: false, error: 'supportsImages must be a boolean' };
  }

  return { valid: true };
}
