/**
 * The web UI's HTTP server and JSON API.
 *
 * Runs on its own port, separate from the proxy, for two reasons: the proxy's
 * port is a Cloud Code API surface where any unclaimed path is forwarded to
 * Google, and keeping them apart means stopping the proxy from the UI does not
 * take the UI down with it.
 *
 * ## Security
 *
 * This server edits config files and can read API keys, so it is locked down:
 *
 * - binds 127.0.0.1 only, never a routable interface
 * - every /api call needs a per-process token, which is embedded in the page it
 *   serves; a random web page cannot read it, which blocks drive-by CSRF
 * - the Host header must be loopback, which defeats DNS rebinding
 * - a cross-origin Origin header is rejected outright
 * - API keys leave the server masked; the browser only ever sends new ones
 */

import * as crypto from 'crypto';
import * as http from 'http';
import log from '../logger';
import { customModelsPath, logFilePath } from '../config';
import * as ide from '../ideSettings';
import * as store from '../modelStore';
import { readLog } from './logTail';
import { testModel } from './testConnection';
import { renderPage } from './page';
import type { CustomModel } from '../proxy';

/** Lets the UI drive the proxy without importing its module directly. */
export interface ProxyControl {
  isRunning(): boolean;
  getPort(): number;
  start(): Promise<number>;
  stop(): Promise<void>;
}

export interface WebUiOptions {
  port: number;
  proxy: ProxyControl;
}

export interface WebUiHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Rejects bodies large enough to be an attack rather than a config. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Proves a request came from the page this process served. */
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

// ─── Request helpers ──────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** True when `host` is a loopback address, with or without a port. */
function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const withoutPort = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
  if (!allowedHosts.includes(withoutPort)) return false;
  // If a port is present it must be ours.
  const match = /:(\d+)$/.exec(host);
  return !match || Number(match[1]) === port;
}

/**
 * Blocks the two ways a hostile page could reach a localhost server: a rebound
 * DNS name (caught by the Host check) and a cross-origin fetch (caught here).
 */
function isOriginAllowed(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches and curl send no Origin
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.host, port);
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ─── API ──────────────────────────────────────────────────────────────────

function statusPayload(proxy: ProxyControl): Record<string, unknown> {
  const ideState = ide.readState();
  const running = proxy.isRunning();
  const proxyPort = proxy.getPort();
  const proxyUrl = `http://127.0.0.1:${proxyPort || 0}`;

  // The state the README warns about: the IDE points here but nothing answers.
  const misconfigured = ideState.routing === 'proxy' && !running;

  return {
    proxy: { running, port: proxyPort, url: proxyUrl },
    ide: {
      found: ideState.found,
      filePath: ideState.filePath,
      candidates: ideState.candidates,
      routing: ideState.routing,
      url: ideState.url,
      commented: ideState.commented,
      settingKey: ide.SETTING_KEY,
    },
    warning: misconfigured
      ? 'The IDE is pointed at this proxy but the proxy is stopped. Nothing will work in the IDE — not even Gemini — until you start it or disable IDE routing.'
      : null,
    paths: { models: customModelsPath(), log: logFilePath() },
    platform: process.platform,
  };
}

/** Shapes an untrusted JSON body into a ModelInput. */
function parseModelInput(body: unknown): store.ModelInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof b[key] === 'string' ? (b[key] as string) : undefined);
  const num = (key: string): number | undefined => {
    const value = b[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  };
  const bool = (key: string): boolean | undefined => (typeof b[key] === 'boolean' ? (b[key] as boolean) : undefined);

  const keyAction = text('keyAction');
  return {
    name: text('name') ?? '',
    provider: text('provider') ?? '',
    apiUrl: text('apiUrl') ?? '',
    displayName: text('displayName'),
    description: text('description'),
    externalModelName: text('externalModelName'),
    timeout: num('timeout'),
    maxRetries: num('maxRetries'),
    allowUnauthorized: bool('allowUnauthorized'),
    supportsImages: bool('supportsImages'),
    keyAction: keyAction === 'set' || keyAction === 'clear' || keyAction === 'keep' ? keyAction : 'keep',
    apiKey: text('apiKey'),
  };
}

function requireIndex(body: unknown): { index: number; expectedName?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const index = typeof b.index === 'number' ? b.index : Number.NaN;
  if (!Number.isInteger(index)) throw new Error('A model index is required.');
  return { index, expectedName: typeof b.expectedName === 'string' ? b.expectedName : undefined };
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
  query: URLSearchParams,
  proxy: ProxyControl,
): Promise<void> {
  const method = req.method || 'GET';

  // Reads
  if (method === 'GET') {
    switch (route) {
      case '/api/status':
        sendJson(res, 200, statusPayload(proxy));
        return;
      case '/api/models':
        sendJson(res, 200, store.snapshot());
        return;
      case '/api/log': {
        const raw = query.get('offset');
        const offset = raw === null || raw === '' ? -1 : Number(raw);
        sendJson(res, 200, readLog(Number.isFinite(offset) ? offset : -1));
        return;
      }
      case '/api/export': {
        const { models, strippedKeys } = store.exportConfig();
        sendJson(res, 200, { models, strippedKeys });
        return;
      }
      default:
        sendError(res, 404, `Unknown endpoint ${route}`);
        return;
    }
  }

  if (method !== 'POST') {
    sendError(res, 405, `${method} is not allowed here`);
    return;
  }

  const body = await readBody(req);

  switch (route) {
    case '/api/proxy/start': {
      if (proxy.isRunning()) {
        sendJson(res, 200, { message: 'Proxy is already running.', status: statusPayload(proxy) });
        return;
      }
      const port = await proxy.start();
      sendJson(res, 200, { message: `Proxy started on 127.0.0.1:${port}.`, status: statusPayload(proxy) });
      return;
    }

    case '/api/proxy/stop': {
      if (!proxy.isRunning()) {
        sendJson(res, 200, { message: 'Proxy is already stopped.', status: statusPayload(proxy) });
        return;
      }
      await proxy.stop();
      const status = statusPayload(proxy);
      sendJson(res, 200, {
        message: status.warning
          ? 'Proxy stopped. The IDE still points here — disable IDE routing or the IDE will not work.'
          : 'Proxy stopped.',
        status,
      });
      return;
    }

    case '/api/ide/enable': {
      const url = `http://127.0.0.1:${proxy.getPort() || 50999}`;
      const result = ide.enableRouting(url);
      sendJson(res, result.ok ? 200 : 400, {
        message: result.message,
        restartRequired: result.ok,
        status: statusPayload(proxy),
      });
      return;
    }

    case '/api/ide/disable': {
      const result = ide.disableRouting();
      sendJson(res, result.ok ? 200 : 400, {
        message: result.message,
        restartRequired: result.ok,
        status: statusPayload(proxy),
      });
      return;
    }

    case '/api/models/create':
      sendJson(res, 200, {
        message: 'Model added.',
        restartRequired: true,
        models: store.createModel(parseModelInput(body)),
      });
      return;

    case '/api/models/update': {
      const { index, expectedName } = requireIndex(body);
      sendJson(res, 200, {
        message: 'Model updated.',
        restartRequired: true,
        models: store.updateModel(index, parseModelInput(body), expectedName),
      });
      return;
    }

    case '/api/models/delete': {
      const { index, expectedName } = requireIndex(body);
      sendJson(res, 200, {
        message: 'Model deleted.',
        restartRequired: true,
        models: store.deleteModel(index, expectedName),
      });
      return;
    }

    case '/api/subagent': {
      const raw = (body as Record<string, unknown>).model;
      const model = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
      const models = store.setSubagentModel(model);
      sendJson(res, 200, {
        // No IDE restart: the proxy re-reads the file per request, and this
        // changes routing only — the dropdown is untouched.
        message: model
          ? `Subagent requests now run on "${model}".`
          : 'Subagent requests now go to Google (default).',
        models,
      });
      return;
    }

    case '/api/models/test': {
      const { index, expectedName } = requireIndex(body);
      const model: CustomModel = store.getRawModel(index, expectedName);
      sendJson(res, 200, await testModel(model));
      return;
    }

    case '/api/import': {
      const result = store.importConfig(body);
      const skippedNote = result.skipped.length ? ` ${result.skipped.length} skipped.` : '';
      sendJson(res, 200, {
        message: `Imported ${result.imported} model(s).${skippedNote}`,
        restartRequired: true,
        skipped: result.skipped,
        models: result.snapshot,
      });
      return;
    }

    default:
      sendError(res, 404, `Unknown endpoint ${route}`);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, options: WebUiOptions): void {
  const { port, proxy } = options;

  if (!isLoopbackHost(req.headers.host, port)) {
    sendError(res, 403, 'This console only accepts requests addressed to localhost.');
    return;
  }
  if (!isOriginAllowed(req, port)) {
    sendError(res, 403, 'Cross-origin requests are not accepted.');
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  } catch {
    sendError(res, 400, 'Malformed request URL');
    return;
  }
  const route = parsed.pathname.replace(/\/+$/, '') || '/';

  // The page itself carries the token, so it is the one unauthenticated route.
  if (route === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    const html = renderPage({ token: SESSION_TOKEN, uiPort: port });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(html)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Inline styles and script are intentional: the page is one self-contained
      // file with no external requests of any kind.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return;
  }

  if (!route.startsWith('/api/')) {
    sendError(res, 404, 'Not found');
    return;
  }

  const presented = req.headers['x-antigravity-token'];
  if (typeof presented !== 'string' || !timingSafeEqual(presented, SESSION_TOKEN)) {
    sendError(res, 401, 'Missing or stale session token. Reload the console page.');
    return;
  }

  handleApi(req, res, route, parsed.searchParams, proxy).catch((err: Error) => {
    // Store and settings failures are expected (bad input, changed file) and
    // belong in the UI as a message rather than a stack trace.
    log.warn(`[WebUI] ${route}: ${err.message}`);
    if (!res.headersSent) sendError(res, 400, err.message);
    else res.end();
  });
}

/** Starts the console. Rejects if the port is taken. */
export function startWebUi(options: WebUiOptions): Promise<WebUiHandle> {
  return new Promise((resolve, reject) => {
    const instance = http.createServer((req, res) => handleRequest(req, res, options));

    instance.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`[WebUI] Port ${options.port} is already in use.`);
      } else {
        log.error('[WebUI] Failed to start:', err);
      }

      reject(err);
    });

    instance.listen(options.port, '127.0.0.1', () => {
      const actual = (instance.address() as import('net').AddressInfo).port;
      const url = `http://127.0.0.1:${actual}`;
      log.info(`[WebUI] Console listening on ${url}`);
      resolve({
        port: actual,
        url,
        close: () =>
          new Promise<void>((done) => {
            instance.closeIdleConnections?.();
            instance.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/** The token the served page embeds. Exposed for tests. */
export function sessionToken(): string {
  return SESSION_TOKEN;
}
