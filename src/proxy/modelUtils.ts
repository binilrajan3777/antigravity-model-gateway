/**
 * Centralized model capability detection, plus the identity helpers that derive
 * a model's dropdown slot and slug.
 *
 * Depends on nothing, so both the proxy and the web UI can share it.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface CustomModelConfig {
  name: string;
  provider: string;
  externalModelName?: string;
  displayName?: string;
  /** Explicit override. Name-based detection cannot know every gateway model. */
  supportsImages?: boolean;
}

export interface ModelCapabilities {
  isThinking: boolean;
  isDeepSeek: boolean;
  isClaude: boolean;
  maxTokens: number;
  maxOutputTokens: number;
  supportsImages: boolean;
}

export interface ModelNameCapabilities {
  isClaudeThinkingModel: boolean;
  isThinkingModel: boolean;
}

// ─── Detection ────────────────────────────────────────────────────────────

const THINKING_PATTERN = /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|opus-5|sonnet-5|fable-5|mythos-5|claude-5|3-7|4-7|3\.7|4\.7/i;
const DEEPSEEK_PATTERN = /deepseek/i;
const CLAUDE_PATTERN = /claude|opus|sonnet/i;
const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|opus-5|sonnet-5|fable-5|mythos-5|claude-5|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4|opus-5|sonnet-5|fable-5|mythos-5|claude-5/i;
const IMAGE_SUPPORT_PATTERN = /gpt-4o|gpt-4-turbo|gpt-5|claude|gemini|vision|llava|qwenvl|pixtral|yi-vision|cogvlm|kimi|moonshot/i;
const NO_IMAGE_PATTERN = /deepseek(?!.*vision)|llama(?!.*vision)|mixtral(?!.*vision)|mistral(?!.*pixtral)|codestral|qwen(?!.*vl)/i;

/**
 * Detects model capabilities from a custom model config object.
 */
export function detectModelCapabilities(m: CustomModelConfig, includeDisplayName = true): ModelCapabilities {
  const nameLower = (m.name || '').toLowerCase();
  const extLower = (m.externalModelName || '').toLowerCase();
  const displayLower = includeDisplayName ? (m.displayName || '').toLowerCase() : '';

  const isThinking =
    m.provider === 'anthropic' ||
    m.provider === 'openai' ||
    m.provider === 'openrouter' ||
    THINKING_PATTERN.test(nameLower) ||
    THINKING_PATTERN.test(extLower) ||
    (includeDisplayName && THINKING_PATTERN.test(displayLower));

  const isDeepSeek =
    DEEPSEEK_PATTERN.test(nameLower) ||
    DEEPSEEK_PATTERN.test(extLower) ||
    (includeDisplayName && DEEPSEEK_PATTERN.test(displayLower));

  const isClaude = m.provider === 'anthropic' || CLAUDE_PATTERN.test(nameLower) || CLAUDE_PATTERN.test(extLower);

  const maxTokens = isClaude ? 200_000 : 1_048_576;
  const maxOutputTokens = isDeepSeek ? 32_768 : isThinking ? 32_768 : 16_384;

  // Image support: Claude, GPT-4o, Gemini always support images. DeepSeek, Ollama text models don't.
  const allNames = nameLower + ' ' + extLower + ' ' + displayLower;
  const supportsImages =
    m.supportsImages !== undefined
      ? m.supportsImages
      :
    m.provider === 'anthropic' ||
    m.provider === 'google' ||
    (m.provider === 'openai' && IMAGE_SUPPORT_PATTERN.test(allNames)) ||
    (m.provider === 'openrouter' && IMAGE_SUPPORT_PATTERN.test(allNames)) ||
    (IMAGE_SUPPORT_PATTERN.test(allNames) && !NO_IMAGE_PATTERN.test(allNames));

  return { isThinking, isDeepSeek, isClaude, maxTokens, maxOutputTokens, supportsImages };
}

// ─── Identity ─────────────────────────────────────────────────────────────

/** Lowest dropdown slot the IDE reserves for injected models. */
export const PLACEHOLDER_MIN = 400;
/** Number of slots available — only 200, hence the collision risk. */
export const PLACEHOLDER_RANGE = 200;

/**
 * Derives the `MODEL_PLACEHOLDER_M<n>` id the IDE uses for a custom model.
 *
 * A djb2 hash of displayName folded into 200 slots. Two models whose names hash
 * to the same slot silently break one of them, which is why the web UI surfaces
 * collisions. The arithmetic must not change: it would reassign every existing
 * model to a different slot.
 */
export function modelPlaceholderId(model: { displayName?: string; name?: string }): string {
  return `MODEL_PLACEHOLDER_M${modelPlaceholderSlot(model)}`;
}

/** The numeric slot behind modelPlaceholderId(). */
export function modelPlaceholderSlot(model: { displayName?: string; name?: string }): number {
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash; // Force 32-bit integer
  }
  return PLACEHOLDER_MIN + (Math.abs(hash) % PLACEHOLDER_RANGE);
}

/** The `custom-…` slug the proxy accepts as an alias for a model. */
export function modelSlug(model: { externalModelName?: string; name?: string }): string {
  return (
    'custom-' +
    (model.externalModelName || model.name || '')
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}

/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
export function detectModelCapabilitiesByName(modelName: string): ModelNameCapabilities {
  const lower = (modelName || '').toLowerCase();
  return {
    isClaudeThinkingModel: CLAUDE_THINKING_PATTERN.test(lower),
    isThinkingModel: THINKING_MODEL_PATTERN.test(lower),
  };
}
