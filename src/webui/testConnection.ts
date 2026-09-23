/**
 * Sends one minimal request to a model's real endpoint and reports what came
 * back.
 *
 * The point is to surface 401 / 410 / "credit balance too low" in the UI rather
 * than mid-conversation. Auth headers and URL normalisation come from the same
 * registry the proxy uses, so a pass here means the proxy's own request would be
 * built the same way.
 */

import * as http from 'http';
import * as https from 'https';
import * as registry from '../proxy/registry';
import log from '../logger';
import type { CustomModel } from '../proxy';

export interface TestOutcome {
  ok: boolean;
  /** HTTP status, or null when the connection never got that far. */
  status: number | null;
  /** Short verdict for the UI. */
  summary: string;
  /** Extra context: the provider's error message, trimmed. */
  detail: string | null;
  durationMs: number;
}

/** Providers that speak Anthropic Messages rather than OpenAI chat. */
function isAnthropicShaped(provider: string): boolean {
  const headers = registry.getProviderHeaders(provider, 'probe');
  return headers['anthropic-version'] !== undefined;
}

/** The smallest request each API will accept, asking for a single token. */
function buildProbeBody(model: CustomModel): string {
  const modelId = model.externalModelName || model.name.replace(/^models\//, '');
  const messages = [{ role: 'user', content: 'ping' }];

  if (model.provider === 'google') {
    return JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1 },
    });
  }
  if (isAnthropicShaped(model.provider)) {
    return JSON.stringify({ model: modelId, max_tokens: 1, messages });
  }
  if (model.provider === 'codex') {
    // Responses API: no `messages`, and a chat-shaped body is answered with a
    // 500 rather than a 400 — which would read as "provider down" in the UI.
    return JSON.stringify({
      model: modelId,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      reasoning: { effort: 'low' },
      stream: false,
    });
  }
  return JSON.stringify({ model: modelId, max_tokens: 1, messages, stream: false });
}

/** Pulls the human-readable message out of a provider error payload. */
function extractError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | string | undefined;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON — fall through to the raw snippet */
  }
  return body.slice(0, 300).trim() || null;
}

/** Turns a transport-level failure into something actionable. */
function describeNetworkError(err: NodeJS.ErrnoException, model: CustomModel): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return model.provider === 'ollama'
        ? 'Connection refused. Is Ollama running? Start it with `ollama serve`.'
        : 'Connection refused — nothing is listening at that address.';
    case 'ENOTFOUND':
      return 'Host not found. Check the domain in apiUrl.';
    case 'ETIMEDOUT':
      return 'Timed out before the endpoint responded.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate rejected. For a self-signed endpoint set allowUnauthorized.';
    default:
      return err.message || 'Request failed before a response arrived.';
  }
}

/** Reads a model's status code into a verdict the UI can colour. */
function summarise(status: number, provider: string): { ok: boolean; summary: string } {
  if (status >= 200 && status < 300) return { ok: true, summary: 'Reachable and authenticated' };

  switch (status) {
    case 400:
      // The endpoint answered and understood us; a 1-token probe is often
      // rejected on its merits, which still proves auth and routing work.
      return { ok: true, summary: 'Endpoint reachable (rejected the 1-token probe)' };
    case 401:
    case 403:
      return { ok: false, summary: provider === 'ollama' ? 'Unexpected auth failure' : 'Rejected the API key' };
    case 404:
      return { ok: false, summary: 'Not found — check apiUrl and the model name' };
    case 410:
      return { ok: false, summary: 'Model retired upstream (410 Gone)' };
    case 429:
      return { ok: false, summary: 'Rate limited or out of quota' };
    default:
      if (status >= 500) return { ok: false, summary: `Provider error (${status})` };
      return { ok: false, summary: `Unexpected status ${status}` };
  }
}

/**
 * Probes `model`. Never throws: a failure is an outcome, not an exception.
 */
export function testModel(model: CustomModel, timeoutMs = 20000): Promise<TestOutcome> {
  const started = Date.now();

  return new Promise((resolve) => {
    let url: string;
    try {
      const translator = registry.getTranslator(model.provider);
      url = registry.getProviderUrl(model.apiUrl, model.externalModelName || model.name, false, translator);
      new URL(url); // throws on a malformed apiUrl
    } catch (err) {
      resolve({
        ok: false,
        status: null,
        summary: 'apiUrl is not a usable URL',
        detail: (err as Error).message,
        durationMs: Date.now() - started,
      });
      return;
    }

    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = buildProbeBody(model);
    const headers: Record<string, string> = {
      ...registry.getProviderHeaders(model.provider, model.apiKey || ''),
      'Content-Length': String(Buffer.byteLength(body)),
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        rejectUnauthorized: model.allowUnauthorized !== true,
      },
      (response) => {
        const chunks: Buffer[] = [];
        // Cap the read: we only need the error message, not a full completion.
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          if (bytes < 8192) {
            chunks.push(chunk);
            bytes += chunk.length;
          }
        });
        response.on('end', () => {
          const status = response.statusCode || 0;
          const text = Buffer.concat(chunks).toString('utf-8');
          const verdict = summarise(status, model.provider);
          resolve({
            ...verdict,
            status,
            detail: verdict.ok && status < 300 ? null : extractError(text),
            durationMs: Date.now() - started,
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve({
        ok: false,
        status: null,
        summary: `No response within ${Math.round(timeoutMs / 1000)}s`,
        detail: 'The endpoint accepted the connection but did not reply in time.',
        durationMs: Date.now() - started,
      });
    });

    request.on('error', (err: NodeJS.ErrnoException) => {
      log.debug(`[TestConnection] ${model.name}: ${err.code || err.message}`);
      resolve({
        ok: false,
        status: null,
        summary: describeNetworkError(err, model),
        detail: err.code ? `${err.code}: ${err.message}` : null,
        durationMs: Date.now() - started,
      });
    });

    request.end(body);
  });
}
