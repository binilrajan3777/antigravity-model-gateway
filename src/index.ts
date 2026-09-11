#!/usr/bin/env node
/**
 * CLI entry point — `npm start`.
 *
 * Runs the proxy and the web console as a plain Node process on Windows, macOS
 * and Linux. There is no Electron here: the logger is our own and every path
 * comes from os.homedir(), so nothing platform-specific is needed beyond what
 * Node already abstracts.
 *
 * The two servers are deliberately separate: the console stays up when the
 * proxy is stopped from the UI, which is the whole point of having a stop
 * button.
 */

import { startProxy, stopProxy, getProxyPort, isProxyRunning } from './proxy';
import { enableLogging, LogLevel } from './logger';
import { customModelsPath, ensureConfigDir, proxyPortSetting, webUiPortSetting } from './config';
import { startWebUi, WebUiHandle, ProxyControl } from './webui/server';

interface CliOptions {
  port?: number;
  uiPort?: number;
  level?: LogLevel;
  quiet: boolean;
  help: boolean;
  ui: boolean;
  open: boolean;
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * Built lazily: the port getters validate their environment variables and throw
 * on a bad value, which must surface as a message from main() rather than as an
 * unhandled throw at module load. --help stays useful either way.
 */
function usage(): string {
  const safe = (read: () => number, fallback: number): string => {
    try {
      return String(read());
    } catch {
      return String(fallback);
    }
  };
  const defaultPort = safe(proxyPortSetting, 50999);
  const defaultUiPort = safe(webUiPortSetting, 50998);

  return `
Antigravity custom-model proxy

  npm start                        Proxy on ${defaultPort}, console on ${defaultUiPort}
  npm start -- --open              Also open the console in your browser
  npm start -- --port 51000        Run the proxy on a specific port
  npm start -- --no-ui             Proxy only, no web console
  npm start -- --log-level debug   Verbose logging

Options
  -p, --port <n>        Proxy port on 127.0.0.1
      --ui-port <n>     Web console port on 127.0.0.1
      --no-ui           Do not start the web console
      --open            Open the console in the default browser
  -l, --log-level <l>   error | warn | info | debug   (default: info)
  -q, --quiet           Suppress console output
  -h, --help            Show this message

Environment
  ANTIGRAVITY_PROXY_PORT   Same as --port
  ANTIGRAVITY_UI_PORT      Same as --ui-port
  ANTIGRAVITY_LOG_LEVEL    Same as --log-level
  ANTIGRAVITY_MODELS_FILE  Path to custom_models.json
  ANTIGRAVITY_PROXY_LOG    Path to the log file
  ANTIGRAVITY_IDE_SETTINGS Path to the IDE's settings.json

The IDE must be pointed at this proxy via "jetski.cloudCodeUrl" in its
settings.json, and must be started after the proxy. The web console can do
that for you. See README.md.
`;
}

function parsePort(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flag} needs a number between 1 and 65535, got "${value ?? ''}"`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { quiet: false, help: false, ui: true, open: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
      case '--no-ui':
        options.ui = false;
        break;
      case '--open':
        options.open = true;
        break;
      case '-p':
      case '--port':
        options.port = parsePort(argv[++i], '--port');
        break;
      case '--ui-port':
        options.uiPort = parsePort(argv[++i], '--ui-port');
        break;
      case '-l':
      case '--log-level': {
        const value = argv[++i];
        if (!LOG_LEVELS.includes(value)) {
          throw new Error(`--log-level must be one of ${LOG_LEVELS.join(', ')}, got "${value ?? ''}"`);
        }
        options.level = value as LogLevel;
        break;
      }
      default:
        throw new Error(`Unknown argument "${arg}". Run with --help for usage.`);
    }
  }

  return options;
}

/** Opens a URL with whatever the platform's default handler is. */
function openBrowser(url: string): void {
  // Imported lazily so the common path does not pay for child_process.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('child_process') as typeof import('child_process');

  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  // start's first quoted argument is the window title, hence the empty string.
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Not being able to open a browser is not worth failing the startup over.
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  let port: number;
  let uiPort: number;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage().trim());
      return;
    }
    // Only consult the environment when no flag was given.
    port = options.port ?? proxyPortSetting();
    uiPort = options.uiPort ?? webUiPortSetting();
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  ensureConfigDir();
  const logFile = enableLogging({ level: options.level, console: !options.quiet });

  try {
    await startProxy(port);
  } catch {
    // startProxy has already logged the cause.
    console.error('\nProxy failed to start. See the log for details.');
    process.exitCode = 1;
    return;
  }

  // The console drives the proxy through this indirection so the web layer
  // never imports the proxy module directly.
  const control: ProxyControl = {
    isRunning: isProxyRunning,
    getPort: () => getProxyPort() || port,
    start: () => startProxy(port),
    stop: stopProxy,
  };

  let ui: WebUiHandle | null = null;
  if (options.ui) {
    try {
      ui = await startWebUi({ port: uiPort, proxy: control });
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'port in use' : (err as Error).message;
      console.error(`\n  Web console unavailable (${reason}). The proxy is still running.`);
      console.error(`  Retry with: npm start -- --ui-port <other>\n`);
    }
  }

  console.log('');
  console.log(`  Proxy      http://127.0.0.1:${getProxyPort()}`);
  console.log(`  Console    ${ui ? ui.url : options.ui ? 'unavailable' : 'disabled (--no-ui)'}`);
  console.log(`  Models     ${customModelsPath()}`);
  console.log(`  Log        ${logFile ?? '(console only)'}`);
  console.log('');
  console.log('  Keep this running, then start Antigravity IDE. Ctrl+C to stop.');
  console.log('');

  if (options.open && ui) openBrowser(ui.url);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      if (ui) await ui.close();
      await stopProxy();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows sends this when the console window is closed.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

void main();
