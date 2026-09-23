# Antigravity Model Gateway

Routes the Antigravity IDE through a local gateway so custom models (Ollama, LiteLLM, NVIDIA,
any OpenAI/Anthropic-compatible provider) appear in the IDE's model dropdown alongside
Google's built-in models.

Runs as a plain Node process on **Windows, macOS and Linux**. No Electron, no binary
patching, no `app.asar` repacking, and **zero runtime dependencies**.

---

## How it works

```
Antigravity IDE
   └─ language server  --cloud_code_endpoint http://127.0.0.1:50999
        └─ this gateway (npm start, port 50999)
             ├─ custom model?  → Ollama / LiteLLM / NVIDIA / any provider
             └─ otherwise      → https://cloudcode-pa.googleapis.com  (Gemini, built-in Claude)

   web console (port 50998) ── manages both the gateway and the IDE setting
```

The gateway is **additive**. It fetches Google's real model list and merges your custom
entries into it, so Google's models keep working exactly as before.

Two moving parts, and both must be in place:

| Part | What it does | Where |
|---|---|---|
| **The endpoint setting** | Points the IDE at the gateway | IDE `settings.json` → `jetski.cloudCodeUrl` |
| **The model config** | Defines which custom models exist | `~/.gemini/antigravity/custom_models.json` |

The web console writes **both** of them, so the whole setup is done in a browser — see
[Web console](#web-console).

---

# Part 1 — First-time setup

## 1.1 Prerequisites

- **Node.js 18+** (`node -v`)
- **Antigravity IDE** installed, and **launched at least once** so it has written its
  `settings.json`
- Whatever backend you want to reach (Ollama, LiteLLM, an API key, ...)

## 1.2 Install and start

```bash
npm install
npm start
```

`npm start` compiles `src/` and launches the gateway plus the web console — the build runs
automatically via `prestart`, so there is no separate build step. It prints where
everything lives:

```
  Proxy      http://127.0.0.1:50999
  Console    http://127.0.0.1:50998
  Models     /home/you/.gemini/antigravity/custom_models.json
  Log        /home/you/.gemini/antigravity/proxy.log

  Keep this running, then start Antigravity IDE. Ctrl+C to stop.
```

Leave the process running. Stop with **Ctrl+C**.

<details>
<summary>All commands</summary>

| Command | What it does |
|---|---|
| `npm start` | Build, then run the gateway and console |
| `npm start -- --open` | Also open the console in your browser |
| `npm start -- --port 51000` | Run the gateway on a different port |
| `npm start -- --ui-port 51001` | Run the console on a different port |
| `npm start -- --no-ui` | Gateway only, no console |
| `npm start -- --log-level debug` | Verbose logging |
| `npm start -- --quiet` | Log to file only, no console output |
| `npm start -- --help` | Full usage |
| `npm run build` | Compile only |
| `npm run dev` | Recompile on change |
| `npm run clean` | Delete the build output |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite |
| `npm run test:watch` | Re-run tests on change |
| `npm run lint` / `npm run lint:fix` | Lint / autofix |
| `npm run format` / `npm run format:check` | Format / check formatting |

Every command is plain Node and `tsc` — identical on all three platforms.

</details>

## 1.3 Finish setup in the console

Open `http://127.0.0.1:50998` (or start with `npm start -- --open`) and do both remaining
steps there:

1. **Turn *IDE routing* on.** The console locates the IDE's `settings.json`, backs it up,
   and writes `jetski.cloudCodeUrl` into it — inserting the key if it is absent,
   uncommenting it if it was turned off before. Every other byte of the file, comments
   included, is left untouched.
2. **Add a model.** The *Add model* form knows the field rules and writes
   `custom_models.json` for you, creating the file if it does not exist. Field reference
   and per-provider recipes: **Part 2** below.

> **Why the setting works:** the IDE reads `jetski.cloudCodeUrl` and passes it to the
> language server as `--cloud_code_endpoint`. Its resolver is literally
> `return cloudCodeUrlOverride || <built-in default>`, so any value you set wins outright.
> Because this is a *setting*, **IDE updates do not break the setup.** There is nothing
> patched to re-patch.

If the console cannot find a `settings.json` — the IDE has never been run, or it is
installed somewhere unusual — see
[Setting the endpoint without the console](#setting-the-endpoint-without-the-console).

## 1.4 Start order

1. `npm start` — leave it running
2. Start Antigravity IDE

**Order matters: gateway first, then the IDE.**

## 1.5 Verify

The console's log panel shows this live; `~/.gemini/antigravity/proxy.log` has the same
thing. A healthy startup and first connection looks like:

```
[Proxy] Server listening on http://127.0.0.1:50999
[Proxy] Request: POST /v1internal:fetchAvailableModels
[Proxy] fetchAvailableModels response status: 200, body length: 189378
[Proxy] Loaded custom models count: 1
[Proxy] Custom model "Qwen3.5 (Ollama direct)" => slug: custom-qwen3-5-latest => model: MODEL_PLACEHOLDER_M456
```

- `status: 200` with a large body = Google is reachable and authenticated
- A `Custom model ...` line per entry = your models were merged in

Your models should now be in the IDE's model dropdown.

---

# Web console

`http://127.0.0.1:50998` — starts with the gateway, no separate command.

Everything in Part 2 can be done here instead of editing JSON by hand, and it is the only
place that can flip the IDE between gateway and Google-direct without you opening
`settings.json`.

## What it does

**Two switches.**

- *Proxy server* — starts and stops the gateway itself. The console runs on its own port,
  so stopping the gateway does not take the console down with it.
- *IDE routing* — comments `jetski.cloudCodeUrl` in and out of the IDE's `settings.json`.
  Disabling keeps the URL inside the comment, so re-enabling restores it.

If the IDE is pointed here while the gateway is stopped — the state that breaks the IDE
entirely, Gemini included — the console shows a red banner rather than letting you find
out during a chat.

**Model management.** Add, edit and delete models through a form that knows the field
rules, with `keep` / `replace` / `remove` for the API key so editing a model never
requires re-typing a credential. A filter box narrows the list by name, provider or
endpoint; `n` opens the add form and `/` jumps to the filter.

**Config checks.** The traps in [2.3](#23-the-four-traps) are detected, not just
documented: duplicate `name` values, `displayName` slot collisions (with a live preview of
the slot while you type a name), and invalid entries. Errors name both models involved.

**Test connection.** Sends one 1-token request to a model's real endpoint and reports the
result, so a `401`, `410 Gone` or `credit balance is too low` shows up in the console
instead of mid-conversation. It builds the request through the same registry the gateway
uses, so a pass means the gateway would send the same thing.

**Log viewer.** Tails `proxy.log` with filtering and an errors-only toggle, so
Troubleshooting rarely needs you to open the file.

**Import / export.** Export writes `custom_models.export.json` **with every API key
stripped**, so a config is safe to share. Import validates each entry and reports what it
skipped rather than writing a broken config.

**Light and dark.** The picker in the top-right switches between light, dark and
*match system*, which is the default; the choice is remembered in the browser. The page
stays one self-contained HTML file with no external stylesheet, script, font or image,
so the console renders identically with no network at all.

## After changing models

The gateway re-reads `custom_models.json` on every request, so routing changes are live.
The **IDE** only reads its model list at startup, so **fully restart the IDE** for
dropdown changes — the console reminds you.

## Local only, and no sign-in

There is no login, no account and no hosting. Specifically:

- Both servers bind **`127.0.0.1` only**. Nothing else on your machine's network — or
  your LAN — can reach them; a request arriving with any other `Host` is refused.
- The page is a **single self-contained file**: no CDN, no web fonts, no external
  requests of any kind, enforced by `Content-Security-Policy: default-src 'none'`. It
  works with no internet at all.
- Writes go to two **local** files only: `custom_models.json` and your IDE's
  `settings.json`. Each is backed up before it is modified.

One piece of invisible plumbing: the server puts a random per-run token in the page it
serves, and the page sends it back with each request. You never see or type it. It is
there because a browser will happily let *any* website you have open POST to
`localhost` — without it, a random page could add models or read your config paths while
the console is running. Requests carrying a foreign `Origin` are rejected for the same
reason.

Since API keys never need to be displayed, they are not sent to the browser at all — the
console only ever shows a masked preview like `sk-a…f912`.

Turn the console off entirely with `npm start -- --no-ui`.

---

# Part 2 — custom_models.json

**File:** `~/.gemini/antigravity/custom_models.json` — the same location on every
platform, resolved from `os.homedir()`. It lives in your user profile rather than this
repo, so it survives moving or re-cloning the project.

Override the location with `ANTIGRAVITY_MODELS_FILE` if you want it elsewhere.

The console writes this file for you; the reference below is for reading it, reviewing a
diff, or editing it directly.

The gateway re-reads it on **every request**, so no restart is needed after an edit.
The **IDE** only reads the model list at startup, so **restart the IDE** to see new
entries in the dropdown.

## 2.1 Field reference

```jsonc
{
  "models": [
    {
      // ---- required ----
      "name": "models/my-model",        // internal ID, must start with "models/" and be UNIQUE
      "provider": "ollama",             // see the provider list below
      "apiUrl": "http://localhost:11434/v1/chat/completions",

      // ---- strongly recommended ----
      "displayName": "My Model",        // dropdown label; its hash picks the dropdown slot
      "externalModelName": "qwen3.5:latest",  // the exact model ID sent to the provider

      // ---- optional ----
      "description": "shown as a subtitle",
      "apiKey": "sk-...",               // omit entirely for Ollama / local
      "timeout": 300000,                // ms, default 120000
      "maxRetries": 3,                  // default 3
      "allowUnauthorized": false,       // true only for self-signed TLS
      "supportsImages": true,           // override image-capability detection (see 2.4)
      "temperature": "omit"             // a number pins it; "omit" sends none (see 2.7)
    }
  ]
}
```

**Valid providers:** `openai`, `anthropic`, `google`, `ollama`, `custom`, `openrouter`,
`codex`, `deepseek`, `groq`, `mistral`, `cerebras`, `kimi`, `fireworks`, `lmstudio`,
`llamacpp`, `nvidia`

The provider determines the auth header and the request translation:

| Provider group | Auth header sent | Body format |
|---|---|---|
| `anthropic` (and Anthropic-compatible) | `x-api-key` + `anthropic-version: 2023-06-01` | Anthropic Messages |
| `google` | `x-goog-api-key` | Google |
| `openrouter` | `Authorization: Bearer` + referer headers | OpenAI |
| `ollama` | **none** | OpenAI |
| `codex` | `Authorization: Bearer` | OpenAI **Responses** |
| everything else (`openai`, `custom`, `nvidia`, ...) | `Authorization: Bearer` | OpenAI |

`codex` is the odd one out: it is a third wire format, not a dialect of the other
two. Endpoints ending in `/responses` take a top-level `instructions` string
instead of a system message, a single `input` array holding messages *and* tool
calls *and* tool results, and flat tool definitions. Pointing `openai` or
`anthropic` at a `/responses` URL sends a body the endpoint rejects — usually
with a 500, which reads like an outage rather than a config error.

## 2.2 Provider recipes

### Ollama (local, no key)

```json
{
  "name": "models/qwen3.5",
  "displayName": "Qwen3.5 (Ollama direct)",
  "provider": "ollama",
  "apiUrl": "http://localhost:11434/v1/chat/completions",
  "externalModelName": "qwen3.5:latest",
  "timeout": 300000
}
```

Find model IDs with `ollama list`. Use a long timeout — a cold model load is slow.
Ollama is the one provider whose URL auto-normalizes (`http://localhost:11434` alone works).

### LiteLLM gateway

LiteLLM speaks both formats; the Anthropic route is used here:

```json
{
  "name": "models/ollama-model",
  "displayName": "Ollama (LiteLLM)",
  "provider": "anthropic",
  "apiKey": "sk-1234",
  "apiUrl": "http://localhost:4000/v1/messages",
  "externalModelName": "ollama-model"
}
```

`externalModelName` is the **LiteLLM alias** (`model_name` in its config), not the
underlying model. List them with:
`curl -H "Authorization: Bearer sk-1234" http://localhost:4000/v1/models`

### OpenAI-compatible gateway

```json
{
  "name": "models/gpt-5.6-luna",
  "displayName": "GPT-5.6 Luna (Experiential Labs)",
  "provider": "custom",
  "apiKey": "xpl_...",
  "apiUrl": "https://api.experientiallabs.ai/v1/chat/completions",
  "externalModelName": "gpt-5.6-luna"
}
```

Use the **API host**, not the web console — e.g. `api.experientiallabs.ai`, since
`platform.experientiallabs.ai` redirects to `/signin`.

### NVIDIA NIM

```json
{
  "name": "models/nvidia-nim",
  "displayName": "NVIDIA NIM",
  "provider": "nvidia",
  "apiKey": "nvapi-...",
  "apiUrl": "https://integrate.api.nvidia.com/v1/chat/completions",
  "externalModelName": "moonshotai/kimi-k3"
}
```

Verify the model still exists before trusting it — NVIDIA retires models and returns
`410 Gone`:
`curl -H "Authorization: Bearer nvapi-..." https://integrate.api.nvidia.com/v1/models`

### kie.ai Codex / GPT-6 (Responses API)

```json
{
  "name": "models/gpt-6-astra",
  "displayName": "GPT 6 Astra",
  "provider": "codex",
  "apiKey": "...",
  "apiUrl": "https://api.kie.ai/codex/v1/responses",
  "externalModelName": "gpt-6-astra",
  "timeout": 300000,
  "maxRetries": 4
}
```

Must be `provider: "codex"`. kie.ai serves these models **only** over the Responses
API — there is no `/chat/completions` route for them, so `openai` and `custom` cannot
reach them either. Model ids come from [kie.ai/market](https://kie.ai/market)
(`gpt-6-astra`, `gpt-5.4-codex`, …).

kie.ai returns intermittent `500` / `503` bodies (`"Service temporarily unavailable"`,
`"please try again later"`) even on well-formed requests, so keep `maxRetries` at 4 —
the proxy retries these and a first-attempt failure is normal rather than a misconfiguration.

### Anthropic (direct API key)

```json
{
  "name": "models/claude-opus-5",
  "displayName": "Claude Opus 5",
  "provider": "anthropic",
  "apiKey": "sk-ant-api03-...",
  "apiUrl": "https://api.anthropic.com/v1/messages",
  "externalModelName": "claude-opus-5"
}
```

Needs an **API key with credits** (`sk-ant-api03-...`). A Claude **subscription** does not
work here and returns `credit balance is too low` — see Troubleshooting.

Claude 5 models (`opus-5`, `sonnet-5`, `fable-5`, `mythos-5`) are detected as thinking
models, so `temperature` is dropped from the request — those models reject it with a 400.
`claude-haiku-4-5` is deliberately excluded, since it still accepts temperature.

## 2.3 The four traps

**1. `displayName` collisions.** The dropdown ID is a hash of `displayName` into only 200
slots (`MODEL_PLACEHOLDER_M400`–`M599`). Two names hashing to the same slot silently break
one model. The console flags a collision as you type; the log also prints the slot for
every model on each model-list fetch.

**2. `name` must be unique.** Model lookup is
`find(m => m.name === x || slug(m) === x || placeholder(m) === x)` and returns the *first*
match. Two entries sharing a `name` means one can silently receive the other's traffic.
Give every entry its own `name`, even when they point at the same gateway.

**3. Invalid entries vanish silently.** A bad `provider` or a missing required field is
skipped with only `Skipping invalid model at index N` in the log — no error surfaces in the
IDE. The model just isn't there. Only `name`, `provider` and `apiUrl` are required.

**4. Full URL paths required.** Except for Ollama, no URL normalization happens. Give the
complete path (`/v1/chat/completions` or `/v1/messages`); a bare base URL fails.

## 2.4 Image support ("Your model does not support this media")

If the IDE refuses an image attachment with *"Your model does not support this media"*,
that verdict comes from the **gateway**, not the provider. The gateway reports each model's
capabilities to the IDE, and image support is inferred from the model **name** against a
regex (`gpt-4o`, `gpt-4-turbo`, `gpt-5`, `claude`, `gemini`, `vision`, `llava`, `pixtral`,
`kimi`, `moonshot`, ...). A multimodal model whose name matches nothing is reported as
text-only, and the IDE blocks the attachment before any request is sent.

Rather than guess from names, state it explicitly:

```jsonc
{
  "name": "models/gpt-5.6-luna",
  "provider": "custom",
  "externalModelName": "gpt-5.6-luna",
  "supportsImages": true          // wins over name-based detection
}
```

`supportsImages` overrides detection in **both** directions — set it `false` to hide the
attach button for a model you know is text-only. Omit it to keep automatic detection.

Check what the gateway decided in the log:

```
[Proxy] Custom model "GPT-5.6 Luna" => slug: custom-gpt-5-6-luna => thinking: true => images: true
```

A second regex forces text-only for families that are usually text-only —
`deepseek`, `llama`, `mixtral`, `mistral`, `codestral`, `qwen` — unless the name also
carries a vision marker (`-vision`, `qwen-vl`, `pixtral`). A multimodal variant outside
that naming needs `"supportsImages": true`.

## 2.5 API keys are NOT encrypted

Keys are stored base64-encoded with a `fallback:` prefix —
`fallback:c2stMTIzNA==` decodes to `sk-1234`. That is obfuscation, not encryption.
**Anyone who can read your user profile can recover every key in this file.** Protect the
file with filesystem permissions, or keep keys out of it entirely.

Writing a key in plaintext is equally fine — the gateway re-encodes it on next load,
*unless* the entry also has `"encrypted": true`, which makes the gateway assume it is
already encoded and leave it as plaintext permanently.

One format cannot be read here: values with an `enc:` prefix, which are sealed by an OS key
store (DPAPI on Windows, Keychain on macOS, libsecret on Linux). A plain Node process
cannot reach those stores, so such a key resolves to
`DECRYPTION_FAILED_STORAGE_UNAVAILABLE` — replace it with the plaintext key and it will be
re-encoded on load.

`custom_models.json`, `*.bak` and `.env*` are gitignored, so a copy kept inside the repo
(for example via `ANTIGRAVITY_MODELS_FILE`) will not be committed by accident.

## 2.6 Browser inspection and commit messages fail with 429 (`subagentModel`)

Ask the agent to inspect a page while a custom model is selected and it can come back
with *"browser-agent resource limit (429 Resource Exhausted)"*. Generating a commit
message fails the same way. The custom model is not at fault, and neither is the browser.

Some steps run on a model **the IDE picks for itself** rather than the one in the
dropdown, and they dispatch their own request against a managed Google model no matter
what you selected:

```
Cloud Code generation request model: gemini-3-flash,       requestType: browser_subagent
Cloud Code generation request model: gemini-3.1-flash-lite, requestType: generate_commit_message
Forwarding /v1internal:streamGenerateContent -> cloudcode-pa.googleapis.com
Upstream 429 ... "Resource has been exhausted (e.g. check quota)"
```

Because those are *managed* models, they hit the same 429 every built-in model hits while
`jetski.cloudCodeUrl` is overridden (see Troubleshooting). So both tools fail for as long
as the gateway is in the path, even though your conversation model is healthy.

**In the web console:** pick one under **Subagent model**. It takes effect on the next
request — no IDE restart, since the dropdown is untouched.

**Or by hand** — a top-level key, a sibling of `models`, not an entry inside it:

```jsonc
{
  "subagentModel": "models/gpt-5.6-luna",   // name, slug, placeholder id or displayName
  "models": [ /* ... */ ]
}
```

The model needs to **support images** — page inspection sends screenshots. The console
flags a text-only choice; by hand, check the log line for your entry reads `images: true`.

**Opt-in, and deliberately narrow.** With no `subagentModel` set nothing is intercepted
and every request forwards to Google as before. Only `browser_subagent` and
`generate_commit_message` are rerouted by default: `agent` is the model you actually
chose, and `tab`/`tab_jump` are high-volume inline completions that already work —
silently moving any of those would spend money on your provider for work you did not ask
to move. Widen it only if you mean to:

```jsonc
"subagentRequestTypes": ["browser_subagent", "generate_commit_message", "checkpoint"]
```

Both keys have environment overrides for testing without editing the file —
`ANTIGRAVITY_SUBAGENT_MODEL` and `ANTIGRAVITY_SUBAGENT_REQUEST_TYPES` (comma-separated).
Environment values win over the file, and the console shows the control as read-only while
one is set. Confirm it is live in the log:

```
[Proxy] Rerouting browser_subagent subagent from gemini-3-flash to custom model "GPT-5.6 Luna"
```

Note the rerouted request bills **your provider**, not your Google quota.

---

## 2.7 Temperature

By default the gateway picks: reasoning models (Claude 4/5, o-series, anything named
`thinking` or `reasoning`) are sent **no** temperature, everything else gets whatever the
IDE asked for, or `0.7`. Some gateway routes accept exactly one value and answer a
request carrying any other with a `400`:

```
The value 0.7 for 'temperature' is not supported by this model route.
Supported values are between 1.0 and 1.0.
```

The gateway recovers from that on its own — it re-sends once with the value the route
named, or without the field. To settle it up front, set it per model, in the web console's
**Advanced** section or in the file:

```jsonc
{ "temperature": 0.2 }      // pinned: sent on every request
{ "temperature": "omit" }   // never sent; the route applies its own
```

Omit the field to keep the automatic behaviour. A number must be between 0 and 2, and it
wins over the automatic choice in both directions.

---

## Daily use

```bash
npm start          # keep running
```

Then start Antigravity IDE.

---

## Switching between gateway and Google-direct

The single control is the `jetski.cloudCodeUrl` line in the IDE's `settings.json`, and the
console's *IDE routing* switch is what operates it — including the backup.

- **To Google direct:** turn *IDE routing* off, then **fully restart the IDE**. Optionally
  stop the gateway. Custom models disappear from the dropdown in this mode; that is
  correct, since the gateway is what injects them.
- **Back to the gateway:** make sure the gateway is running, turn *IDE routing* on, then
  **fully restart the IDE**.

> **The one rule: never leave the setting active while the gateway is down.**
> The IDE then points at a dead port and *nothing* works — not even Gemini. The console
> shows a red banner when you are in that state.

A full IDE restart is required either way: the endpoint is passed when the language server
spawns at startup, so a running instance will not pick up the change.

---

## Configuration reference

Every setting has a flag, and most have an environment variable. Flags win.

| Flag | Environment variable | Default |
|---|---|---|
| `-p`, `--port <n>` | `ANTIGRAVITY_PROXY_PORT` | `50999` |
| `--ui-port <n>` | `ANTIGRAVITY_UI_PORT` | `50998` |
| `--no-ui` | — | console enabled |
| `--open` | — | off |
| `-l`, `--log-level <l>` | `ANTIGRAVITY_LOG_LEVEL` | `info` |
| `-q`, `--quiet` | — | off |
| `-h`, `--help` | — | — |
| — | `ANTIGRAVITY_MODELS_FILE` | `~/.gemini/antigravity/custom_models.json` |
| — | `ANTIGRAVITY_PROXY_LOG` | `~/.gemini/antigravity/proxy.log` |
| — | `ANTIGRAVITY_IDE_SETTINGS` | auto-detected per platform |
| — | `ANTIGRAVITY_SUBAGENT_MODEL` | unset (feature off) |
| — | `ANTIGRAVITY_SUBAGENT_REQUEST_TYPES` | `browser_subagent`, `generate_commit_message` |

Changing the port means changing `jetski.cloudCodeUrl` to match — re-run the console's
*IDE routing* switch — then fully restarting the IDE.

The gateway binds `127.0.0.1` only — never a public interface. If the port is occupied it
**fails loudly** rather than falling back to a random port: the IDE is pointed at one fixed
URL, so a gateway listening elsewhere would be running but unreachable.

### Setting the endpoint without the console

Only needed when running `--no-ui`, or when the console reports no `settings.json` — which
means the IDE has not been launched yet, or it lives somewhere unexpected. In the second
case, point `ANTIGRAVITY_IDE_SETTINGS` at the file and use the console as normal.

The file the console edits:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Antigravity IDE\User\settings.json` |
| macOS | `~/Library/Application Support/Antigravity IDE/User/settings.json` |
| Linux | `~/.config/Antigravity IDE/User/settings.json` |

The IDE has shipped under more than one product name, so an `Antigravity` directory without
the `IDE` suffix is also checked. The key, added inside the top-level `{ }` block:

```jsonc
{
  // ... your existing settings ...
  "jetski.cloudCodeUrl": "http://127.0.0.1:50999"
}
```

Watch the commas — every entry except the last needs a trailing comma. Commenting the line
out with `//` is how you switch back to Google-direct while keeping the URL for later.

---

## Troubleshooting

The console's log panel names the cause in almost every case;
`~/.gemini/antigravity/proxy.log` is the same content on disk.
`npm start -- --log-level debug` if you need more.

| Symptom | Cause | Fix |
|---|---|---|
| `Port 50999 is already in use` | An earlier gateway is still running | Stop it, or `npm start -- --port <other>` and update the IDE setting |
| `Web console unavailable (port in use)` | Something holds 50998. The gateway still starts | `npm start -- --ui-port <other>` |
| Console says `Reload the console page` | The gateway restarted, so its session token changed | Reload the browser tab |
| Console shows no IDE settings file | The IDE has never been launched, or its config is somewhere unexpected | Launch the IDE once, or set `ANTIGRAVITY_IDE_SETTINGS` to the full path |
| Nothing works, not even Gemini | Setting active but gateway down | Start the gateway, or turn *IDE routing* off |
| `Upstream 429` on generation, but `fetchAvailableModels` returns 200 | Google account quota exhausted. Affects **all** built-in models (Gemini *and* built-in Claude) — one shared pool | Wait for reset, or use custom models |
| Browser inspection or commit-message generation fails with 429 while a **custom** model is selected | Both run on a managed Google model the IDE picks itself (`browser_subagent`, `generate_commit_message`), not on your model | Pick one under **Subagent model** in the console — see [2.6](#26-browser-inspection-and-commit-messages-fail-with-429-subagentmodel) |
| Custom model missing from dropdown | Invalid entry, or IDE not restarted | Check the log for `Skipping invalid model` |
| `The value 0.7 for 'temperature' is not supported by this model route` | The route pins temperature to one value | The gateway retries once with the accepted value; pin or disable it per model to avoid the round trip — see [2.7](#27-temperature) |
| `Your model does not support this media` | Capability inferred as text-only from the model name; the provider is not involved | Add `"supportsImages": true` — see 2.4 |
| Wrong model answers | Two entries share a `name` | Make every `name` unique |
| `DECRYPTION_FAILED_STORAGE_UNAVAILABLE` | Key is in the OS key store `enc:` format | Replace with the plaintext key — see 2.5 |
| `credit balance is too low` (Anthropic) | A Claude **subscription** is not API credit | Buy API credits, or use the Claude Code panel |
| `410 Gone` / model not found | Model retired upstream | Check the provider's `/v1/models` list |
| Works via LiteLLM but not direct | Different model alias behind the gateway | Compare `externalModelName` on both |

### Claude models

A Claude Code **subscription** cannot power Antigravity's dropdown — the subscription
covers Anthropic's own clients. Antigravity's agent calling the API bills separately and
needs an API key with credits. If the Claude Code extension is installed in the IDE,
subscription Claude is available in that panel — just not through Antigravity's own model
dropdown.

---

## Full removal

1. Turn *IDE routing* off in the console (or delete the `jetski.cloudCodeUrl` line by hand)
2. Fully restart the IDE
3. Stop the gateway (Ctrl+C)

Nothing else to undo — no binaries are patched and no application files are modified.

---

## Project layout

```
src/
  index.ts             CLI entry point (npm start): starts the gateway and the console
  proxy.ts             HTTP server: Google passthrough, model-list injection, routing
  logger.ts            Console + file logging (no-op until the CLI enables it)
  config.ts            Cross-platform paths and ports, all derived from os.homedir()
  cryptoStore.ts       API key encoding for custom_models.json (base64 — see 2.5)
  schemaValidator.ts   Validates model entries; the authority on which fields are required
  ideSettings.ts       Finds the IDE's settings.json and toggles jetski.cloudCodeUrl
  modelStore.ts        Model CRUD, key masking, duplicate and slot-collision detection
  subagentRouting.ts   Resolves subagentModel / subagentRequestTypes (see 2.6)
  proxy/
    shared.ts          Cross-turn state with TTL cleanup
    modelUtils.ts      Capability detection, plus slot and slug derivation
    registry.ts        Auto-discovers translators, maps provider → translator + headers
    translators/       openai · anthropic · google · ollama, plus shared utils
  webui/
    server.ts          Loopback HTTP server and JSON API for the console
    page.ts            The console page — one self-contained HTML document
    testConnection.ts  One-token probe of a model's real endpoint
    logTail.ts         Incremental log reads for the log panel
  __tests__/           Vitest suite (202 tests across 9 files)
```

`ideSettings.ts` edits `settings.json` surgically rather than parsing and re-serialising
it, because the file is JSONC and a round trip would delete every comment in it. Each
write is preceded by a backup and followed by a parse check.

`registry.ts` discovers translators by scanning the compiled `dist/proxy/translators/`
directory at import time, so **a new provider format needs no registration** — add a
translator module and it is picked up on next build.

## License

Apache-2.0 — see [LICENSE](LICENSE).
