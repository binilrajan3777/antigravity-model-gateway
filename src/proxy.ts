/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import log from './logger';
import { customModelsPath, proxyPortSetting } from './config';
import { readSubagentConfig, resolveSubagentModel } from './subagentRouting';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CustomModel {
  // Required — enforced by validateCustomModel() in schemaValidator.ts.
  name: string;
  provider: string;
  apiUrl: string;

  // Optional. apiKey is genuinely absent for local providers such as Ollama.
  displayName?: string;
  description?: string;
  apiKey?: string;
  externalModelName?: string;
  allowUnauthorized?: boolean;
  supportsImages?: boolean;
  encrypted?: boolean;
  _slug?: string;
  timeout?: number;
  maxRetries?: number;
}

interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  model_id?: string;
  request?: GeminiRequestBody;
  systemInstruction?: { parts: { text?: string }[] };
  contents?: {
    parts?: { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean }[];
    role?: string;
  }[];
  tools?: unknown[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

// ─── Imports ──────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let proxyPort = 0;

// Shared cross-turn state
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  touchStateTimestamp,
  startCleanupInterval,
  stopCleanupInterval,
} from './proxy/shared';

// Model configuration, capability detection, and identity helpers
import { detectModelCapabilities, modelPlaceholderId, modelSlug } from './proxy/modelUtils';

// Provider translator registry (auto-discovers translators from proxy/translators/)
import * as registry from './proxy/registry';

// API key storage for custom_models.json (base64 obfuscation — see cryptoStore)
import * as cryptoStore from './cryptoStore';

// Runtime validation of custom model entries
import { validateCustomModel } from './schemaValidator';

// ─── Model Helpers ────────────────────────────────────────────────────────

// Slot and slug derivation live in modelUtils so the web UI shares one
// implementation — a second copy could drift and reassign dropdown slots.
const generateModelPlaceholderId = modelPlaceholderId;
const toSlug = modelSlug;

function getCustomModelsPath(): string {
  return customModelsPath();
}

// ─── Model Loading ────────────────────────────────────────────────────────

/**
 * ANTIGRAVITY_PASSTHROUGH_ONLY=1 turns this into a plain forwarding proxy: no
 * custom models, no catalog injection, no response rewriting beyond what a
 * transparent hop requires.
 *
 * It exists to answer one question that theory kept failing to settle — whether
 * a failure comes from what this proxy adds, or from merely being in the path.
 * Run it with the flag: if the symptom survives, every injection feature is
 * exonerated in a single test.
 */
function isPassthroughOnly(): boolean {
  return process.env.ANTIGRAVITY_PASSTHROUGH_ONLY === '1';
}

function loadCustomModels(): CustomModel[] {
  if (isPassthroughOnly()) return [];

  const filePath = getCustomModelsPath();

  if (!fs.existsSync(filePath)) {
    const defaultModels = {
      models: [
        {
          name: 'models/gpt-4o',
          displayName: 'GPT-4o (OpenAI via Proxy)',
          description: 'OpenAI GPT-4o model redirected through proxy',
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
          externalModelName: 'gpt-4o',
        },
        {
          name: 'models/claude-3-5-sonnet',
          displayName: 'Claude 3.5 Sonnet (Anthropic via Proxy)',
          description: 'Anthropic Claude 3.5 Sonnet model redirected through proxy',
          provider: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY',
          apiUrl: 'https://api.anthropic.com/v1/messages',
          externalModelName: 'claude-3-5-sonnet-latest',
        },
        {
          name: 'models/llama3',
          displayName: 'Llama 3 (Local Ollama)',
          description: 'Local Ollama Llama 3 model run on your machine',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1/chat/completions',
          externalModelName: 'llama3',
        },
      ],
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      (defaultModels.models as CustomModel[]).forEach((m) => {
        (m as unknown as Record<string, unknown>).encrypted = false;
      });
      const encrypted = cryptoStore.encryptModels(defaultModels.models);
      fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
    } catch (e) {
      log.error('[Proxy] Failed to write default custom_models.json', e);
    }
    return cryptoStore.decryptModels(defaultModels.models);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { models?: CustomModel[] };
    const models = parsed.models || [];

    // Auto-migration check
    const needsMigration = models.some(
      (m) =>
        !m.encrypted &&
        m.apiKey &&
        m.apiKey !== 'none' &&
        !m.apiKey.startsWith('enc:') &&
        !m.apiKey.startsWith('fallback:'),
    );
    if (needsMigration) {
      log.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
      cryptoStore.backupFile(filePath);
      const encryptedModels = cryptoStore.encryptModels(models);
      try {
        fs.writeFileSync(filePath, JSON.stringify({ models: encryptedModels }, null, 2), 'utf-8');
        log.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
        return cryptoStore.decryptModels(encryptedModels);
      } catch (err) {
        log.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
      }
    }

    const decrypted = cryptoStore.decryptModels(models) as CustomModel[];

    // Validate all models
    const validModels: CustomModel[] = [];
    for (let i = 0; i < decrypted.length; i++) {
      const validation = validateCustomModel(decrypted[i]) as { valid: boolean; error?: string };
      if (validation.valid) {
        validModels.push(decrypted[i]);
      } else {
        log.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
      }
    }
    if (validModels.length < decrypted.length) {
      log.info(
        `[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`,
      );
    }

    return validModels;
  } catch (e) {
    log.error('[Proxy] Failed to parse custom_models.json', e);
    return [];
  }
}

// ─── Google Proxy ─────────────────────────────────────────────────────────

/**
 * Shared connection pool for Google passthrough.
 *
 * Without an agent every request opens its own TLS connection against an
 * unbounded socket pool, so abandoned requests keep a connection (and an
 * upstream generation) alive with nothing watching them. Pooling reuses
 * sockets the way a normal client does and caps how many can be open at once.
 */
const googleAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 32,
  maxFreeSockets: 8,
});

/** Google requests currently open upstream. Surfaced on /health. */
let googleInFlight = 0;

export function getGoogleInFlight(): number {
  return googleInFlight;
}

/** Decode an upstream error body for logging only — the original bytes are still forwarded. */
function decodeForLog(buf: Buffer, encoding?: string | string[]): string {
  const enc = Array.isArray(encoding) ? encoding[0] : encoding;
  try {
    const zlib = require('zlib');
    if (enc === 'gzip') return zlib.gunzipSync(buf).toString('utf-8');
    if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf-8');
    if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf-8');
  } catch {
    /* fall through to raw */
  }
  return buf.toString('utf-8');
}

function proxyToGoogle(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer): void {
  const isCloudCodeUrl = req.url!.includes('v1internal') || req.url!.includes('daily-cloudcode');
  const targetUrl = isCloudCodeUrl
    ? 'https://cloudcode-pa.googleapis.com'
    : 'https://generativelanguage.googleapis.com';
  const parsedUrl = new URL(req.url!, targetUrl);

  const headers: Record<string, string | string[] | undefined> = {
    ...(req.headers as Record<string, string | string[] | undefined>),
  };
  headers['host'] = isCloudCodeUrl ? 'cloudcode-pa.googleapis.com' : 'generativelanguage.googleapis.com';

  // Hop-by-hop headers describe the connection they arrived on, not the one we
  // are about to open, so none of them may be forwarded (RFC 9110 §7.6.1).
  for (const hop of ['connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-connection']) {
    delete headers[hop];
  }

  // Request framing is ours to declare, not the client's to dictate. The body is
  // already buffered here, so state its real length and drop the inbound
  // chunked framing — forwarding `transfer-encoding` while writing a complete
  // buffer describes the wrong connection. The language server sends large
  // agent turns chunked and small completions with content-length, which is why
  // this only ever bit one class of request.
  delete headers['transfer-encoding'];
  if (reqBody && reqBody.length > 0) {
    headers['content-length'] = String(reqBody.length);
  } else {
    delete headers['content-length'];
  }

  const isGeneration = req.url!.includes('generateContent') || req.url!.includes('streamGenerateContent');
  const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;

  if (shouldBufferAndModify) {
    delete headers['accept-encoding'];
  }

  // Describes what we forward upstream. Google attributes quota by credential
  // and quota-project, so when a request is refused it matters which of those
  // actually survived the hop. On for generation requests without a flag to
  // set, because the one time it is needed is a failure already in progress.
  // Values are never logged — only names, and a length for the ones that are
  // secrets, so this stays safe to leave on.
  if (isGeneration) {
    const describe = (name: string): string => {
      const v = headers[name];
      if (v === undefined) return `${name}=MISSING`;
      const s = Array.isArray(v) ? v.join(',') : String(v);
      // Credentials and anything key-shaped are reported by length only.
      if (name === 'authorization' || name.includes('key') || name.includes('token')) {
        return `${name}=<${s.length} chars>`;
      }
      return `${name}=${s}`;
    };
    const interesting = ['authorization', 'x-goog-user-project', 'x-goog-api-key', 'x-goog-api-client', 'user-agent'];
    const googHeaders = Object.keys(headers).filter((h) => h.startsWith('x-goog') && !interesting.includes(h));
    log.info(
      `[Proxy] Forwarding ${req.url} -> ${headers['host']} | ` +
        [...interesting, ...googHeaders].map(describe).join(' | ') +
        ` | allHeaders: ${Object.keys(headers).sort().join(',')}`,
    );
  }

  const options: https.RequestOptions = {
    method: req.method,
    headers: headers as Record<string, string>,
    agent: googleAgent,
  };

  googleInFlight++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    googleInFlight--;
  };

  const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
    // Headers are in, so the connect-phase deadline no longer applies. A
    // streaming generation can legitimately sit silent for minutes while the
    // model thinks — cutting it at 60s kills the answer mid-stream and the IDE
    // immediately re-asks, which is exactly how one slow turn becomes a burst.
    // The long ceiling still reclaims a genuinely dead socket.
    proxyReq.setTimeout(isGeneration ? 600_000 : 60_000);

    if (shouldBufferAndModify) {
      const responseChunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        const fullResBody = Buffer.concat(responseChunks);
        let text: string;
        const encoding = proxyRes.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            const zlib = require('zlib');
            text = zlib.gunzipSync(fullResBody).toString('utf-8');
          } catch (e) {
            log.error('[Proxy] gunzipSync failed:', e);
            text = fullResBody.toString('utf-8');
          }
        } else {
          text = fullResBody.toString('utf-8');
        }

        log.info(
          `[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`,
        );
        // P0-3: Response body content is NOT logged to disk. Only metadata.

        // Exception, deliberate and narrow: these two endpoints return the
        // caller's own entitlement and quota state and carry no credentials.
        // Whether a refusal is a real allowance running out or something this
        // proxy does to the request cannot be told apart without them.
        if (req.url!.includes('retrieveUserQuotaSummary') || req.url!.includes('loadCodeAssist')) {
          log.info(`[Proxy] QUOTA-DIAG ${req.url}: ${text.substring(0, 2500)}`);
        }

        const proxyHost = req.headers.host || 'localhost';
        text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
        text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);

        const modifiedHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
        delete modifiedHeaders['content-encoding'];
        // We send a fixed-length buffer below, so any upstream chunked framing no longer applies.
        // Leaving it alongside content-length is illegal HTTP and strict clients (undici) reject it.
        delete modifiedHeaders['transfer-encoding'];

        const modifiedBuffer = Buffer.from(text, 'utf-8');
        modifiedHeaders['content-length'] = String(modifiedBuffer.length);

        if (res.destroyed || res.writableEnded) return;
        res.writeHead(proxyRes.statusCode || 200, modifiedHeaders as Record<string, string>);
        res.end(modifiedBuffer);
      });
    } else {
      const passthroughHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
      // Only strip framing when BOTH are present - that pair is illegal HTTP and strict
      // clients reject it. Leave a lone transfer-encoding alone so SSE streams unaffected.
      if (passthroughHeaders['content-length'] && passthroughHeaders['transfer-encoding']) {
        delete passthroughHeaders['transfer-encoding'];
      }
      if ((proxyRes.statusCode || 200) >= 400) {
        // Error bodies are small and never streamed, so buffer to log why the
        // call was rejected. A bare "429" says nothing about which quota was
        // hit — concurrent streams, per-minute, or daily all look identical.
        const errChunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => errChunks.push(chunk));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(errChunks);
          log.error(
            `[Proxy] Upstream ${proxyRes.statusCode} for ${req.url} (inFlight: ${googleInFlight}): ` +
              decodeForLog(raw, proxyRes.headers['content-encoding']).substring(0, 500),
          );
          if (res.destroyed || res.writableEnded) return;
          // A fixed buffer replaces whatever framing upstream used.
          delete passthroughHeaders['transfer-encoding'];
          passthroughHeaders['content-length'] = String(raw.length);
          res.writeHead(proxyRes.statusCode || 500, passthroughHeaders as Record<string, string>);
          res.end(raw);
        });
        return;
      }
      log.info(`[Proxy] Upstream ${proxyRes.statusCode} for ${req.url} (streamed)`);
      res.writeHead(proxyRes.statusCode || 200, passthroughHeaders as Record<string, string>);
      proxyRes.pipe(res);
    }
  });

  // Arm a connect/first-response deadline. setTimeout() only measures socket
  // idle time, so registering it inside the response callback (as this used to)
  // left a stalled connect with no deadline at all.
  proxyReq.on('timeout', () => {
    log.error(`[Proxy] Google request timed out for ${req.url}`);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
    } else {
      res.end();
    }
  });
  proxyReq.setTimeout(30_000);

  // The IDE cancels generations constantly — stop button, edited prompt, a
  // superseded autocomplete. Nothing here used to tell Google about it, so the
  // abandoned generation ran to completion and kept counting against Cloud
  // Code's concurrency quota. Enough orphans and every new request comes back
  // 429 until the proxy restarts and the sockets die with it.
  res.on('close', () => {
    if (!res.writableFinished) {
      log.info(`[Proxy] Client disconnected, aborting upstream ${req.url} (inFlight: ${googleInFlight})`);
      proxyReq.destroy();
    }
  });

  proxyReq.on('close', release);

  proxyReq.on('error', (err) => {
    release();
    // A destroy() we initiated on client disconnect is not a failure to report.
    if (res.writableEnded || res.destroyed) {
      log.info(`[Proxy] Upstream request ended early for ${req.url}: ${err.message}`);
      return;
    }
    log.error('[Proxy] Google Forwarding Error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
    } else {
      res.end();
    }
  });

  if (reqBody) {
    proxyReq.write(reqBody);
  }
  proxyReq.end();
}

// ─── File Data Resolver ────────────────────────────────────────────────────

async function resolveFileData(body: GeminiRequestBody, reqHeaders: Record<string, string | string[] | undefined>): Promise<void> {
  const contents = body.contents;
  if (!contents) return;
  const authHeader = (reqHeaders['authorization'] || reqHeaders['Authorization'] || '') as string;
  for (const item of contents) {
    if (!item.parts) continue;
    for (let i = 0; i < item.parts.length; i++) {
      const p = item.parts[i] as Record<string, unknown>;
      const fd = p.fileData as { mimeType?: string; fileUri?: string } | undefined;
      if (!fd?.fileUri) continue;
      try {
        const uri = fd.fileUri; let fileContent = '';
        if (uri.startsWith('file://')) {
          const fp = uri.replace('file://', '').replace(/\//g, path.sep);
          if (fs.existsSync(fp)) {
            const mime = fd.mimeType || '';
            if (mime.startsWith('image/')) {
              // Binary read as utf-8 is destroyed. Convert to an inline image part
              // so the translators can emit a real image block.
              const b64 = fs.readFileSync(fp).toString('base64');
              (item.parts[i] as Record<string, unknown>) = { inlineData: { mimeType: mime, data: b64 } };
              log.info(`[Proxy] file:// image -> inlineData (${mime}, ${b64.length} b64 chars)`);
              continue;
            }
            fileContent = fs.readFileSync(fp, 'utf-8');
          }
        } else if (authHeader && uri.startsWith('https://')) {
          fileContent = await downloadFileContent(uri, authHeader);
        }
        if (fileContent) {
          (item.parts[i] as Record<string, unknown>) = { text: '[File content]:\n\n' + fileContent };
        }
      } catch (e) { log.warn('[Proxy] File resolve failed:', (e as Error).message); }
    }
  }
}

function downloadFileContent(url: string, authHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers: { 'Authorization': authHeader }, timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let d = ''; res.on('data', (c: Buffer) => d += c.toString()); res.on('end', () => resolve(d));
    }).on('error', reject).end();
  });
}

// ─── Custom Model Request Handler ─────────────────────────────────────────

/**
 * Parses the Retry-After header from upstream responses (RFC 7231 §7.1.3).
 * Returns delay in milliseconds, or 0 if no valid header is present.
 */
function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number {
  const val = headers['retry-after'];
  if (!val) return 0;

  const raw = Array.isArray(val) ? val[0] : val;
  if (!raw) return 0;

  // Try delta-seconds (e.g. "120")
  const seconds = parseInt(raw.trim(), 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try HTTP-date (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return 0;
}

function handleCustomModelRequest(
  res: http.ServerResponse,
  model: CustomModel,
  geminiBody: GeminiRequestBody,
  isStream: boolean,
  retryCount = 0,
): void {
  // A cancelled turn must not keep burning provider quota. Without this the
  // retry ladder below happily re-fires against a client that is long gone.
  if (res.destroyed || res.writableEnded) {
    log.info(`[Proxy] Client gone, skipping ${retryCount > 0 ? 'retry for ' : 'request to '}${model.name}`);
    return;
  }

  // P3-18: Configurable max retries per model (default 3, min 0, max 5)
  const MAX_RETRIES = Math.min(Math.max(model.maxRetries ?? 3, 0), 5);
  const REQUEST_TIMEOUT_MS = model.timeout || 120_000;

  const provider = model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;

  const payload = registry.translateRequest(provider, geminiBody, model.externalModelName);
  const headers = registry.getProviderHeaders(provider, model.apiKey);

  if (isStream && registry.supportsStreaming(provider)) {
    (payload as Record<string, unknown>).stream = true;
  }

  let finalUrlStr = model.apiUrl;
  // P3-15: Google AI Studio uses dynamic URL construction for streaming vs non-streaming
  // P3-16: Ollama uses URL normalization for default port and endpoint
  if (provider === 'google' || provider === 'ollama') {
    const providerTranslator = registry.getTranslator(provider);
    finalUrlStr = registry.getProviderUrl(finalUrlStr, model.externalModelName, isStream, providerTranslator);
  } else if (provider === 'openai' || model.provider === 'custom' || model.provider === 'openrouter') {
    const urlLower = finalUrlStr.toLowerCase();
    if (!urlLower.includes('/chat/completions') && !urlLower.includes('/completions')) {
      if (finalUrlStr.endsWith('/v1')) {
        finalUrlStr += '/chat/completions';
      } else if (!finalUrlStr.endsWith('/')) {
        finalUrlStr += '/v1/chat/completions';
      } else {
        finalUrlStr += 'v1/chat/completions';
      }
    }
  }
  const url = new URL(finalUrlStr);
  const client = url.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    headers: headers as Record<string, string>,
  };

  // P0-2: SSL bypass ONLY when user explicitly opts in via allowUnauthorized.
  // Custom providers no longer bypass SSL automatically.
  if (model.allowUnauthorized) {
    log.warn(
      `[Proxy] SSL verification DISABLED for ${model.name} (allowUnauthorized=true). Connection is vulnerable to MITM.`,
    );
    (options as Record<string, unknown>).rejectUnauthorized = false;
  }

  log.info(
    `[Proxy] Routing ${model.name} to ${model.provider} (${model.apiUrl}) (isStream: ${!!isStream})${retryCount > 0 ? ` (retry ${retryCount})` : ''}`,
  );

  const request = client.request(url, options, (apiRes) => {
    apiRes.on('error', (err) => {
      log.error(`[Proxy] Upstream stream error for ${model.name}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream connection error: ' + err.message } }));
      } else {
        res.end();
      }
    });

    if (isStream) {
      // Check for API errors BEFORE writing streaming headers
      if (apiRes.statusCode! >= 400) {
        let errorBody = '';
        apiRes.on('data', (chunk: Buffer) => errorBody += chunk.toString());
        apiRes.on('end', () => {
          log.error(`[Proxy] Stream API error (${apiRes.statusCode}) for ${model.name}: ${errorBody.substring(0, 300)}`);
          if (retryCount < MAX_RETRIES) {
            log.warn(`[Proxy] Stream error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
            return;
          }
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(errorBody);
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let buffer = '';
      apiRes.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);

              if (mapped) {
                const cloudCodeResponse = {
                  response: { candidates: [mapped] },
                  traceId: '',
                  metadata: {},
                };
                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
              }
            } catch (err) {
              // Partial/invalid JSON chunks are normal during streaming; debug-level only
              log.debug(`[Proxy] Stream chunk parse warning for ${model.name}:`, (err as Error).message);
            }
          }
        }
      });

      apiRes.on('end', () => {
        if (buffer.trim().startsWith('data: ')) {
          const dataStr = buffer.trim().substring(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);
              if (mapped) {
                const cloudCodeResponse = {
                  response: { candidates: [mapped] },
                  traceId: '',
                  metadata: {},
                };
                res.write(`data: ${JSON.stringify(cloudCodeResponse)}\n\n`);
              }
            } catch (e) {
              log.debug(`[Proxy] Stream buffer drain parse warning for ${model.name}:`, (e as Error).message);
            }
          }
        }

        const finalChunk = {
          response: {
            candidates: [
              {
                content: { parts: [], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          traceId: '',
          metadata: {},
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.end();
      });
    } else {
      let body = '';
      apiRes.on('data', (chunk: Buffer) => (body += chunk));
      apiRes.on('end', () => {
        // Retry on 5xx with exponential backoff
        if (apiRes.statusCode! >= 500 && apiRes.statusCode! < 600 && retryCount < MAX_RETRIES) {
          const retryAfter = parseRetryAfter(apiRes.headers);
          const delay = retryAfter > 0 ? retryAfter : 1000 * Math.pow(2, retryCount);
          log.warn(
            `[Proxy] Server error ${apiRes.statusCode} for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`,
          );
          setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), delay);
          return;
        }

        // Retry on 429 with Retry-After header support + exponential backoff
        if (apiRes.statusCode === 429 && retryCount < MAX_RETRIES) {
          const retryAfter = parseRetryAfter(apiRes.headers);
          const delay = retryAfter > 0 ? retryAfter : 2000 * Math.pow(2, retryCount);
          log.warn(
            `[Proxy] Rate limited (429) for ${model.name}, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES})...`,
          );
          setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), delay);
          return;
        }

        if (apiRes.statusCode! >= 400) {
          // P0-3: Only log status code and model name, NOT response body content
          log.error(`[Proxy] API error (${apiRes.statusCode}) for ${model.name}`);
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(body);
          return;
        }

        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;

          const reasoning =
            (parsed as { choices?: { message?: { reasoning_content?: string; reasoning?: string } }[] }).choices?.[0]
              ?.message?.reasoning_content ||
            (parsed as { choices?: { message?: { reasoning_content?: string; reasoning?: string } }[] }).choices?.[0]
              ?.message?.reasoning;
          if (reasoning) {
            modelReasoningContent.set(model.name, reasoning);
            touchStateTimestamp(stateTimestamps.reasoning, model.name);
          }

          const providerForResponse =
            model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;
          const mapped = registry.translateResponse(providerForResponse, parsed, model.name);

          const cloudCodeResponse = {
            response: mapped,
            traceId: '',
            metadata: {},
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cloudCodeResponse));
        } catch (e) {
          log.error('[Proxy] Failed to map response:', e);

          if (retryCount < MAX_RETRIES) {
            log.warn(`[Proxy] Parse error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(
              () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1),
              1000 * (retryCount + 1),
            );
            return;
          }

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Failed to translate model response' } }));
        }
      });
    }
  });

  // Propagate client cancellation upstream — same reasoning as proxyToGoogle.
  // The early-return at the top of this function stops the resulting socket
  // error from being mistaken for a failure worth retrying.
  res.on('close', () => {
    if (!res.writableFinished) {
      log.info(`[Proxy] Client disconnected, aborting upstream request to ${model.name}`);
      request.destroy();
    }
  });

  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    log.error(`[Proxy] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${model.name}`);
    request.destroy();

    if (retryCount < MAX_RETRIES) {
      log.warn(`[Proxy] Timeout for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(
        () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1),
        1000 * (retryCount + 1),
      );
      return;
    }

    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s` } }));
    }
  });

  request.on('error', (err) => {
    log.error('[Proxy] Custom Model Request Error:', err);

    if (retryCount < MAX_RETRIES) {
      log.warn(`[Proxy] Network error for ${model.name}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      setTimeout(
        () => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1),
        1000 * (retryCount + 1),
      );
      return;
    }

    if (isStream) {
      if (!res.headersSent) {
        const errResponse = {
          response: {
            candidates: [
              {
                content: { parts: [{ text: 'Network error: ' + err.message }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          },
          traceId: '',
          metadata: {},
        };
        res.write('data: ' + JSON.stringify(errResponse) + '\n\n');
      }
      res.end();
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
      }
    }
  });

  request.write(JSON.stringify(payload));
  request.end();
}

// ─── Protobuf Utilities ────────────────────────────────────────────────────

interface ProtoField {
  tag: number;        // full tag (field_number << 3 | wire_type)
  wireType: number;
  fieldNum: number;
  value: number | Buffer | ProtoField[];
  start: number;
  end: number;
}

function readVarint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  while (offset + bytes < buf.length) {
    const byte = buf[offset + bytes];
    result |= (byte & 0x7f) << shift;
    bytes++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, bytes };
}

function encodeVarint(value: number): Buffer {
  const parts: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    parts.push(b);
  } while (v !== 0);
  return Buffer.from(parts);
}

function parseProto(buf: Buffer, offset: number, end: number): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = offset;
  while (pos < end) {
    const start = pos;
    const tagVarint = readVarint(buf, pos);
    const tag = tagVarint.value;
    const wireType = tag & 0x07;
    const fieldNum = tag >>> 3;
    pos += tagVarint.bytes;

    if (wireType === 0) {
      const v = readVarint(buf, pos);
      fields.push({ tag, wireType, fieldNum, value: v.value, start, end: pos + v.bytes });
      pos += v.bytes;
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, pos);
      pos += lenVarint.bytes;
      const len = lenVarint.value;
      const children = parseProto(buf, pos, pos + len);
      const hasChildren = children.length > 0;
      fields.push({ tag, wireType, fieldNum, value: hasChildren ? children : buf.subarray(pos, pos + len), start, end: pos + len });
      pos += len;
    } else if (wireType === 1) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
      pos += 8;
    } else if (wireType === 5) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function encodeProtoBuf(fields: { tag: number; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const tagBuf = encodeVarint(field.tag);
    const data = field.value;
    const lenBuf = encodeVarint(data.length);
    parts.push(tagBuf, lenBuf, data);
  }
  return Buffer.concat(parts);
}

function findModelEntryFieldTag(fields: ProtoField[]): number | null {
  const tagCounts = new Map<number, number>();
  for (const f of fields) {
    if (f.wireType === 2) {
      tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
    }
  }
  let bestTag: number | null = null;
  let bestCount = 0;
  for (const [tag, count] of tagCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestTag = tag;
    }
  }
  if (bestTag !== null && bestCount >= 2) {
    // Verify it has nested messages
    const sample = fields.find((f) => f.tag === bestTag && Array.isArray(f.value));
    if (sample) return bestTag;
  }
  return bestTag;
}

function extractFieldMapping(entry: ProtoField[]): Map<number, 'string' | 'varint' | 'bytes'> {
  const mapping = new Map<number, 'string' | 'varint' | 'bytes'>();
  for (const f of entry) {
    if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
      mapping.set(f.fieldNum, 'string');
    } else if (f.wireType === 0) {
      mapping.set(f.fieldNum, 'varint');
    } else if (f.wireType === 2 && Array.isArray(f.value)) {
      mapping.set(f.fieldNum, 'bytes');
    }
  }
  return mapping;
}

function encodeModelEntryForGetModels(
  name: string,
  displayName: string,
  mapping: Map<number, 'string' | 'varint' | 'bytes'>,
): Buffer {
  const fields: { tag: number; value: Buffer }[] = [];
  for (const [fieldNum, protoType] of mapping) {
    if (protoType === 'string') {
      const tag = (fieldNum << 3) | 2;
      if (fieldNum === 1) {
        fields.push({ tag, value: Buffer.from(name, 'utf-8') });
      } else if (fieldNum === 2) {
        fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
      } else {
        fields.push({ tag, value: Buffer.alloc(0) });
      }
    } else if (protoType === 'varint') {
      const tag = (fieldNum << 3) | 0;
      fields.push({ tag, value: encodeVarint(0) });
    } else {
      const tag = (fieldNum << 3) | 2;
      fields.push({ tag, value: Buffer.alloc(0) });
    }
  }
  return encodeProtoBuf(fields);
}

// ─── GetAvailableModels Proxy Handler ───────────────────────────────────────

function handleGetAvailableModelsProxy(
  res: http.ServerResponse,
  reqBody: Buffer,
  lsUrl: string,
): void {
  const lsParsed = new URL(lsUrl);
  const client = lsParsed.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    hostname: lsParsed.hostname,
    port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
    path: lsParsed.pathname + lsParsed.search,
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      'Accept': 'application/grpc-web+proto',
      'Content-Length': String(reqBody.length),
    },
    rejectUnauthorized: false,
  };

  const lsReq = client.request(options, (lsRes) => {
    const chunks: Buffer[] = [];
    lsRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    lsRes.on('end', () => {
      const responseBuf = Buffer.concat(chunks);
      const customModels = loadCustomModels();
      let modifiedBuf = responseBuf;

      if (customModels.length > 0 && responseBuf.length > 6) {
        try {
          const flags = responseBuf[0];
          const msgLen = responseBuf.readUInt32BE(1);
          if (5 + msgLen <= responseBuf.length) {
            const msgBody = responseBuf.subarray(5, 5 + msgLen);
            const parsed = parseProto(msgBody, 0, msgBody.length);
            const modelTag = findModelEntryFieldTag(parsed);

            if (modelTag !== null) {
              const sampleEntry = parsed.find(
                (f) => f.tag === modelTag && Array.isArray(f.value),
              );
              if (sampleEntry && Array.isArray(sampleEntry.value)) {
                const fieldMapping = extractFieldMapping(sampleEntry.value);
                const newParts: Buffer[] = [msgBody];

                for (const m of customModels) {
                  const placeholderId = generateModelPlaceholderId(m);
                  const entry = encodeModelEntryForGetModels(
                    'models/' + placeholderId,
                    m.displayName,
                    fieldMapping,
                  );
                  const tagBuf = encodeVarint(modelTag);
                  const lenBuf = encodeVarint(entry.length);
                  newParts.push(tagBuf, lenBuf, entry);
                  log.info(
                    `[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`,
                  );
                }

                const newMsgBody = Buffer.concat(newParts);
                const newHeader = Buffer.alloc(5);
                newHeader[0] = flags;
                newHeader.writeUInt32BE(newMsgBody.length, 1);
                modifiedBuf = Buffer.concat([newHeader, newMsgBody]);
              }
            }
          }
        } catch (err) {
          log.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
        }
      }

      res.writeHead(lsRes.statusCode || 200, {
        'Content-Type': 'application/grpc-web+proto',
        'Content-Length': String(modifiedBuf.length),
      });
      res.end(modifiedBuf);
    });

    lsRes.on('error', (err) => {
      log.error('[Proxy] LS error for GetAvailableModels:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });
  });

  lsReq.setTimeout(30_000, () => {
    log.error('[Proxy] GetAvailableModels forward timed out');
    lsReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end();
    }
  });

  lsReq.on('error', (err) => {
    log.error('[Proxy] GetAvailableModels forward error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });

  lsReq.write(reqBody);
  lsReq.end();
}

// ─── Main Request Handler ─────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  req.url = req.url!.replace(/^.*\/dummy_path_padding/, '');
  // Strip binary patch padding (from LS hostname replacement)
  req.url = req.url!.replace(/\/v1internal\/x{7}/, '');

  // Health check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        port: proxyPort,
        memory: {
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        state: {
          googleInFlight,
          activeStreamContexts: activeStreamContexts.size,
          modelToolCallIds: modelToolCallIds.size,
          translatedToolCalls: translatedToolCalls.size,
          modelReasoningContent: modelReasoningContent.size,
        },
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // P0-4: Enforce maximum request body size to prevent memory exhaustion DoS
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
  let bodyLength = 0;
  let bodyRejected = false;

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_BODY_SIZE) {
      if (!bodyRejected) {
        bodyRejected = true;
        log.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }),
          );
        }
      }
      return;
    }
    bodyChunks.push(chunk);
  });
  req.on('end', () => {
    if (bodyRejected) return;

    const fullBody = Buffer.concat(bodyChunks);
    const bodyStr = fullBody.toString('utf-8');

    log.info(`[Proxy] Request: ${req.method} ${req.url}`);

    // 0. Intercept GetAvailableModels (redirected from Electron webRequest)
    if (req.url!.startsWith('/GetAvailableModels')) {
      const gavParsed = new URL(req.url!, 'http://127.0.0.1');
      const lsUrl = gavParsed.searchParams.get('ls');
      if (lsUrl) {
        handleGetAvailableModelsProxy(res, fullBody, lsUrl);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ls parameter' }));
      return;
    }

    // 1. Intercept /v1internal:fetchAvailableModels
    // Skipped in passthrough-only mode so the catalog is never parsed and
    // re-serialised — the bytes Google sent reach the IDE untouched.
    if (!isPassthroughOnly() && req.url!.includes('/v1internal:fetchAvailableModels')) {
      log.info('[Proxy] Intercepting fetchAvailableModels request');

      const targetUrl = 'https://cloudcode-pa.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const fwdHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      fwdHeaders['host'] = 'cloudcode-pa.googleapis.com';
      delete fwdHeaders['connection'];
      delete fwdHeaders['keep-alive'];
      delete fwdHeaders['accept-encoding'];
      // Same framing correction as proxyToGoogle — declare our own body length.
      delete fwdHeaders['transfer-encoding'];
      if (fullBody && fullBody.length > 0) {
        fwdHeaders['content-length'] = String(fullBody.length);
      } else {
        delete fwdHeaders['content-length'];
      }

      const fwdOptions: https.RequestOptions = {
        method: req.method,
        headers: fwdHeaders as Record<string, string>,
      };

      const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
        // P0-5: Timeout for fetchAvailableModels forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] fetchAvailableModels forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            customModels.forEach((m) => {
              const slug = toSlug(m);
              mappedCustom[slug] = {
                displayName: m.displayName,
                maxTokens: 1048576,
                maxOutputTokens: 4096,
                model: generateModelPlaceholderId(m),
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            log.info(
              `[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`,
            );

            const googleJson = JSON.parse(googleBody) as Record<string, unknown>;
            const customModels = loadCustomModels();

            log.info(`[Proxy] Loaded custom models count: ${customModels.length}`);

            const mergeModels = (target: unknown): unknown => {
              if (Array.isArray(target)) {
                const mapped = customModels.map((m) => {
                  const cap = detectModelCapabilities(m, true);
                  return {
                    name: 'models/' + generateModelPlaceholderId(m),
                    version: '1.0',
                    displayName: m.displayName,
                    description: m.description,
                    inputTokenLimit: cap.maxTokens,
                    outputTokenLimit: cap.maxOutputTokens,
                    supportedGenerationMethods: ['generateContent', 'countTokens'],
                    temperature: cap.isThinking ? undefined : 0.7,
                    topP: cap.isThinking ? undefined : 0.9,
                    topK: cap.isThinking ? undefined : 40,
                  };
                });
                return [...mapped, ...target];
              } else if (target && typeof target === 'object') {
                const result = { ...(target as Record<string, unknown>) };
                customModels.forEach((m) => {
                  const slug = toSlug(m);
                  const cap = detectModelCapabilities(m, true);
                  const entry: Record<string, unknown> = {
                    displayName: m.displayName,
                    supportsImages: cap.supportsImages,
                    supportsThinking: cap.isThinking,
                    recommended: true,
                    maxTokens: cap.maxTokens,
                    maxOutputTokens: cap.maxOutputTokens,
                    tokenizerType: 'LLAMA_WITH_SPECIAL',
                    model: generateModelPlaceholderId(m),
                    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                    modelProvider: 'MODEL_PROVIDER_GOOGLE',
                  };
                  if (cap.supportsImages) {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'image/png': true,
                      'image/jpeg': true,
                      'image/webp': true,
                      'image/gif': true,
                      'image/heic': true,
                      'image/heif': true,
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  } else {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  }
                  (result as Record<string, unknown>)[slug] = entry;
                  m._slug = slug;
                  log.info(
                    `[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: ${generateModelPlaceholderId(m)} => thinking: ${cap.isThinking} => images: ${cap.supportsImages}`,
                  );
                });
                return result;
              }
              return target;
            };

            let merged = false;
            if (googleJson.models) {
              googleJson.models = mergeModels(googleJson.models);
              merged = true;
            }
            if (googleJson.availableModels) {
              googleJson.availableModels = mergeModels(googleJson.availableModels);
              merged = true;
            }
            if (googleJson.available_models) {
              googleJson.available_models = mergeModels(googleJson.available_models);
              merged = true;
            }

            if (!merged) {
              const modelsMap: Record<string, unknown> = {};
              customModels.forEach((m) => {
                const slug = toSlug(m);
                modelsMap[slug] = {
                  displayName: m.displayName,
                  recommended: true,
                  maxTokens: 1048576,
                  maxOutputTokens: 4096,
                  tokenizerType: 'LLAMA_WITH_SPECIAL',
                  model: generateModelPlaceholderId(m),
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                };
                m._slug = slug;
              });
              googleJson.models = modelsMap;
            }

            // Inject custom model slugs into agentModelSorts
            const customSlugs = customModels.map((m) => m._slug).filter(Boolean) as string[];
            if (customSlugs.length > 0) {
              if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                (googleJson.agentModelSorts as { groups?: { modelIds?: string[] }[] }[]).forEach((sort) => {
                  if (sort.groups && Array.isArray(sort.groups)) {
                    sort.groups.forEach((group) => {
                      if (group.modelIds && Array.isArray(group.modelIds)) {
                        customSlugs.forEach((slug) => {
                          if (!group.modelIds!.includes(slug)) {
                            group.modelIds!.push(slug);
                          }
                        });
                      }
                    });
                  }
                });
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Parsing fetchAvailableModels failed, returning custom models:', err);
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            customModels.forEach((m) => {
              const slug = toSlug(m);
              mappedCustom[slug] = {
                displayName: m.displayName,
                maxTokens: 1048576,
                maxOutputTokens: 4096,
                model: generateModelPlaceholderId(m),
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
        const customModels = loadCustomModels();
        const mappedCustom: Record<string, unknown> = {};
        customModels.forEach((m) => {
          const slug = toSlug(m);
          mappedCustom[slug] = {
            displayName: m.displayName,
            maxTokens: 1048576,
            maxOutputTokens: 4096,
            model: generateModelPlaceholderId(m),
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: mappedCustom }));
      });

      if (fullBody && fullBody.length > 0) {
        googleReq.write(fullBody);
      }
      googleReq.end();
      return;
    }

    // 2. Intercept /v1beta/models or /v1/models list request
    if (!isPassthroughOnly() && req.method === 'GET' && (req.url!.endsWith('/models') || req.url!.includes('/models?'))) {
      log.info('[Proxy] Intercepting models list request');

      const targetUrl = 'https://generativelanguage.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const mdlHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      mdlHeaders['host'] = 'generativelanguage.googleapis.com';
      delete mdlHeaders['connection'];
      delete mdlHeaders['accept-encoding'];
      // A GET carries no body; inbound framing must not leak onto our request.
      delete mdlHeaders['transfer-encoding'];
      delete mdlHeaders['content-length'];

      const mdlOptions: https.RequestOptions = { method: 'GET', headers: mdlHeaders as Record<string, string> };

      const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {
        // P0-5: Timeout for models list forward request (30s)
        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] Models list forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                models: customModels.map((m) => ({
                  name: m.name,
                  displayName: m.displayName,
                  description: m.description,
                  supportedGenerationMethods: ['generateContent'],
                })),
              }),
            );
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(googleBody) as { models?: unknown[] };
            const customModels = loadCustomModels();

            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: 1048576,
              outputTokenLimit: 4096,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
              temperature: 0.7,
              topP: 0.9,
              topK: 40,
            }));

            if (googleJson.models) {
              googleJson.models = [...mappedCustom, ...googleJson.models];
            } else {
              googleJson.models = mappedCustom;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Google list models failed, returning custom models list only:', err);
            const customModels = loadCustomModels();
            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: 1048576,
              outputTokenLimit: 4096,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Google models list request error:', err);
        const customModels = loadCustomModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: customModels.map((m) => ({
              name: m.name,
              displayName: m.displayName,
              description: m.description,
              supportedGenerationMethods: ['generateContent'],
            })),
          }),
        );
      });
      googleReq.end();
      return;
    }

    // 3. Intercept Cloud Code generation stream or non-stream requests
    const isCloudCodeStream =
      req.url!.includes('/v1internal:streamGenerateContent') || req.url!.includes('/v1internal:generateContent');
    if (req.method === 'POST' && isCloudCodeStream) {
      try {
        const reqJson = JSON.parse(bodyStr) as Record<string, unknown>;
        const modelName = reqJson.model as string | undefined;
        const modelId = (reqJson.modelId || reqJson.model_id) as string | undefined;
        // project and requestType decide which quota bucket Google bills. If the
        // language server sends a different project when it is pointed at a
        // custom endpoint, that alone explains a refusal the direct path never
        // sees — and comparing a working tab completion against a failing chat
        // turn shows it immediately. Neither value is a secret.
        log.info(
          `[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, ` +
            `project: ${String(reqJson.project ?? 'MISSING')}, requestType: ${String(reqJson.requestType ?? 'MISSING')}, ` +
            `url: ${req.url}, bodySize: ${fullBody.length}, bodyKeys: ${Object.keys(reqJson).join(',')}`,
        );
        if (modelName) {
          const customModels = loadCustomModels();
          const matchedCustomModel = customModels.find((m) => {
            const enumName = generateModelPlaceholderId(m);
            return m.name === modelName || toSlug(m) === modelName || enumName === modelName || enumName === modelId;
          });
          if (matchedCustomModel) {
            log.info(
              `[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`,
            );
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
            // Resolve fileData URIs then route to translator
            resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
              handleCustomModelRequest(res, matchedCustomModel, actualGeminiBody, isStream);
            });
            return;
          }

          // No custom model matched, so this is one of Google's own. When the
          // IDE picked it for an internal subagent rather than the user picking
          // it in the dropdown, an opt-in override can serve it from a custom
          // model — see subagentRouting.ts for why that is worth doing.
          if (!isPassthroughOnly()) {
            const subagentConfig = readSubagentConfig(getCustomModelsPath());
            const subagentModel = resolveSubagentModel(customModels, subagentConfig, reqJson.requestType);
            if (subagentModel) {
              log.info(
                `[Proxy] Rerouting ${String(reqJson.requestType)} subagent from ${modelName} ` +
                  `to custom model "${subagentModel.displayName || subagentModel.name}"`,
              );
              const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
              const actualGeminiBody = (reqJson.request || reqJson) as GeminiRequestBody;
              resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(
                () => {
                  handleCustomModelRequest(res, subagentModel, actualGeminiBody, isStream);
                },
              );
              return;
            }
          }
        }
      } catch (err) {
        log.error('[Proxy] Failed to parse Cloud Code stream body:', err);
      }
    }

    // 4. Intercept standard generateContent / streamGenerateContent request
    const generateMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
    const streamMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);

    const isGenerate = !!generateMatch;
    const isStandardStream = !!streamMatch;

    if (req.method === 'POST' && (isGenerate || isStandardStream)) {
      const matchedModelName = isGenerate ? generateMatch![1] : streamMatch![1];
      const customModels = loadCustomModels();
      const matchedCustomModel = customModels.find((m) => {
        const enumName = generateModelPlaceholderId(m);
        return (
          m.name === matchedModelName ||
          toSlug(m) === matchedModelName ||
          enumName === matchedModelName ||
          'models/' + enumName === matchedModelName
        );
      });

      if (matchedCustomModel) {
        try {
          const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
          resolveFileData(geminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
            handleCustomModelRequest(res, matchedCustomModel, geminiBody, isStandardStream);
          });
          return;
        } catch (e) {
          log.error('[Proxy] JSON parse error in request body:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
          return;
        }
      }
    }

    // 5. Fallback: transparent proxy to Google
    proxyToGoogle(req, res, fullBody);
  });
}

// ─── Server Start/Stop ────────────────────────────────────────────────────

/**
 * Binds the proxy to `port` on loopback.
 *
 * The port is not negotiable: the IDE passes a fixed proxy URL to its language
 * server at startup, so binding anything else means the IDE talks to nothing.
 * An occupied port therefore rejects rather than falling back to a random one —
 * a hard failure at startup beats a proxy that is up but unreachable.
 */
export function startProxy(port: number = proxyPortSetting()): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);

    // P1-9: Start managed cleanup interval
    startCleanupInterval();

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`[Proxy] Port ${port} is already in use — most likely another proxy instance.`);
      } else {
        log.error('[Proxy] Startup failed:', err);
      }
      stopCleanupInterval();
      server = null;
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      proxyPort = (server!.address() as import('net').AddressInfo).port;
      log.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
      if (isPassthroughOnly()) {
        log.warn('[Proxy] PASSTHROUGH-ONLY mode: custom models and catalog injection are disabled.');
      }
      resolve(proxyPort);
    });
  });
}

/**
 * Closes the listener and resolves once it is down.
 *
 * server.close() alone waits for every open connection to end, and the IDE
 * holds keep-alive sockets — so a plain close can hang indefinitely. Idle
 * sockets are dropped immediately and anything still in flight gets a short
 * grace period before being cut, which keeps the UI's stop button responsive.
 */
export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    // P1-9: Stop cleanup interval to prevent orphaned timers
    stopCleanupInterval();

    const active = server;
    if (!active) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      server = null;
      log.info('[Proxy] Server stopped');
      resolve();
    };

    const graceTimer = setTimeout(() => {
      log.warn('[Proxy] Forcing remaining connections closed');
      active.closeAllConnections?.();
      finish();
    }, 3000);
    // Do not let the grace timer hold the process open on shutdown.
    graceTimer.unref?.();

    active.close(finish);
    // Release keep-alive sockets that are just parked, so close() can proceed.
    active.closeIdleConnections?.();
  });
}

export function getProxyPort(): number {
  return proxyPort;
}

/** True while the proxy is bound and accepting connections. */
export function isProxyRunning(): boolean {
  return server !== null && server.listening;
}
