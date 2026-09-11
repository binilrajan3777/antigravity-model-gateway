/**
 * Ollama Translator.
 *
 * Ollama is fully OpenAI-compatible (channels/v1/chat/completions).
 * This module re-exports the OpenAI translator functions and adds
 * Ollama-specific helpers:
 *   - Default URL normalization (localhost:11434 fallback)
 *   - User-friendly error message translation
 */

import log from '../../logger';

// ─── Re-export all OpenAI translator functions ────────────────────────────
// The registry auto-discovers these by naming convention:
//   mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini
// Ollama uses the exact same format, so we re-export verbatim.

export { mapGeminiToOpenAI, mapOpenAIToGemini, mapOpenAIChunkToGemini } from './openai';

// ─── Ollama-Specific Helpers ──────────────────────────────────────────────

/**
 * Normalizes an Ollama API URL to the standard chat completions endpoint.
 *
 * Handles these common patterns:
 *   http://localhost:11434              → http://localhost:11434/v1/chat/completions
 *   http://localhost:11434/v1           → http://localhost:11434/v1/chat/completions
 *   http://localhost                    → http://localhost:11434/v1/chat/completions
 *   http://10.0.0.5:11434/api/generate  → kept as-is (non-chat endpoint)
 *
 * If localhost has no port, defaults to Ollama's standard port 11434.
 */
export function getOllamaApiUrl(baseUrl: string): string {
  let url = baseUrl;

  // If it already has a specific API path, don't touch it
  if (url.includes('/api/')) {
    return url;
  }

  // Clean trailing slash
  url = url.replace(/\/$/, '');

  // If no port on localhost, use default Ollama port
  if (url.match(/^https?:\/\/localhost$/)) {
    url = 'http://localhost:11434';
    log.info('[OllamaTranslator] Added default Ollama port 11434');
  }

  // If URL ends with /v1, append /chat/completions
  if (url.endsWith('/v1')) {
    url += '/chat/completions';
    return url;
  }

  // If URL doesn't have a chat completions path, add full /v1/chat/completions
  if (!url.includes('/chat/completions') && !url.includes('/completions')) {
    url += '/v1/chat/completions';
  }

  return url;
}
