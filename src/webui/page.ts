/**
 * The console page: one self-contained HTML document.
 *
 * Everything is inline — no external stylesheet, script, font or image — so the
 * console works with no network at all, which matters for a localhost tool.
 * That is also why the CSP in server.ts permits inline style and script.
 *
 * Theming: a tiny script in <head> resolves the stored preference (light / dark
 * / auto) into a data-theme attribute before first paint, so there is no flash.
 * Every colour in the sheet comes from a token, and only the token block is
 * duplicated per theme.
 *
 * The client script below deliberately avoids backticks and `${`, since this
 * whole file is a template literal.
 */

export interface PageOptions {
  /** Per-process API token, embedded so the page can authenticate. */
  token: string;
  uiPort: number;
}

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Antigravity Proxy Console</title>
<script>
/* Resolve the theme before paint so the page never flashes the wrong one. */
(function () {
  var root = document.documentElement;
  var pref = 'auto';
  try { pref = localStorage.getItem('antigravity.theme') || 'auto'; } catch (e) { /* private mode */ }
  if (pref !== 'light' && pref !== 'dark') pref = 'auto';
  var dark = pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
})();
</script>
<style>
/* ══ Tokens ═══════════════════════════════════════════════════════════════ */

:root {
  color-scheme: light;

  --bg: #f2f0ec;
  --bg-veil: rgba(255, 255, 255, 0.72);
  --surface: #ffffff;
  --surface-2: #faf9f6;
  --surface-3: #f0eee8;
  --line: #e3ded4;
  --line-strong: #cec7b9;

  --ink: #15181c;
  --ink-2: #4d545c;
  --ink-3: #868d94;

  --accent: #0f62c8;
  --accent-soft: rgba(15, 98, 200, 0.1);
  --solid: #15181c;
  --solid-ink: #fbfaf7;

  --ok: #0e8a5f;
  --warn: #a96a00;
  --err: #c23b2e;
  --info: #0f6fa8;

  --glow-a: rgba(15, 98, 200, 0.13);
  --glow-b: rgba(224, 122, 40, 0.13);
  --grain: 0.035;

  --sh-1: 0 1px 2px rgba(30, 26, 18, 0.05), 0 1px 1px rgba(30, 26, 18, 0.04);
  --sh-2: 0 2px 4px rgba(30, 26, 18, 0.05), 0 8px 20px -6px rgba(30, 26, 18, 0.1);
  --sh-3: 0 24px 60px -18px rgba(30, 26, 18, 0.32), 0 4px 12px rgba(30, 26, 18, 0.1);

  --r-xl: 18px;
  --r-lg: 14px;
  --r-md: 10px;
  --r-sm: 7px;

  --display: ui-serif, "New York", Georgia, "Iowan Old Style", "Times New Roman", serif;
  --sans: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", Ubuntu, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}

:root[data-theme="dark"] {
  color-scheme: dark;

  --bg: #0a0c0f;
  --bg-veil: rgba(12, 15, 19, 0.72);
  --surface: #12161b;
  --surface-2: #171c22;
  --surface-3: #1e242c;
  --line: #242b34;
  --line-strong: #333c48;

  --ink: #e6ebf1;
  --ink-2: #a2acb8;
  --ink-3: #6d7885;

  --accent: #5aa6ff;
  --accent-soft: rgba(90, 166, 255, 0.14);
  --solid: #e6ebf1;
  --solid-ink: #0a0c0f;

  --ok: #34d399;
  --warn: #f5b544;
  --err: #ff6b6b;
  --info: #7dd3fc;

  --glow-a: rgba(60, 130, 246, 0.16);
  --glow-b: rgba(52, 211, 153, 0.09);
  --grain: 0.055;

  --sh-1: 0 1px 2px rgba(0, 0, 0, 0.5);
  --sh-2: 0 2px 6px rgba(0, 0, 0, 0.4), 0 12px 28px -10px rgba(0, 0, 0, 0.6);
  --sh-3: 0 28px 70px -20px rgba(0, 0, 0, 0.8), 0 6px 16px rgba(0, 0, 0, 0.5);
}

/* ══ Base ═════════════════════════════════════════════════════════════════ */

* { box-sizing: border-box; }
html { height: 100%; }

body {
  margin: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--ink);
  font: 400 14px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  scrollbar-color: var(--line-strong) transparent;
  scrollbar-width: thin;
}

/* Atmosphere: two soft light sources plus a fine grain, no external assets. */
.aurora {
  position: fixed;
  inset: 0;
  z-index: -2;
  pointer-events: none;
  background:
    radial-gradient(58rem 30rem at 12% -8%, var(--glow-a), transparent 62%),
    radial-gradient(46rem 26rem at 92% 2%, var(--glow-b), transparent 60%);
}
.aurora::after {
  content: "";
  position: absolute;
  inset: 0;
  opacity: var(--grain);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
}

::selection { background: var(--accent-soft); }

a { color: var(--accent); }

.wrap { max-width: 1200px; margin: 0 auto; padding: 26px 24px 90px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ══ Top bar ══════════════════════════════════════════════════════════════ */

.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--bg-veil);
  backdrop-filter: saturate(1.6) blur(14px);
  -webkit-backdrop-filter: saturate(1.6) blur(14px);
  border-bottom: 1px solid var(--line);
}
.topbar-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 13px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.mark { display: block; color: var(--ink); flex: none; }
.mark .orbit { transform-box: fill-box; transform-origin: center; animation: orbit 16s linear infinite; }
@keyframes orbit { to { transform: rotate(360deg); } }

.wordmark {
  display: block;
  font-family: var(--display);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.012em;
  line-height: 1.1;
}
.brand-sub {
  display: block;
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-top: 2px;
}

.topbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}
.pill b { color: var(--ink); font-weight: 550; font-variant-numeric: tabular-nums; }
.pill .k { color: var(--ink-3); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }

/* Theme picker */
.theme {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
}
.theme button {
  width: 28px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  padding: 0;
  transition: background 0.16s, color 0.16s;
}
.theme button:hover { color: var(--ink); }
.theme button[aria-pressed="true"] { background: var(--surface-3); color: var(--ink); box-shadow: var(--sh-1); }
.theme svg { width: 14px; height: 14px; }

/* ══ Cards ════════════════════════════════════════════════════════════════ */

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-1);
  padding: 20px;
  animation: rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: calc(var(--d, 0) * 55ms);
}
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.card-head h2 {
  margin: 0;
  font-family: var(--display);
  font-size: 17px;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.hint { font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.eyebrow {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-3);
  font-weight: 550;
}

section + section, .deck + section, .stats + section { margin-top: 16px; }

/* ══ Control deck ═════════════════════════════════════════════════════════ */

.deck { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 16px; margin-top: 22px; }

.control-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.control-state {
  margin: 9px 0 0;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.015em;
  display: flex;
  align-items: center;
  gap: 10px;
}
.control-sub {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--ink-3);
  font-family: var(--mono);
  overflow-wrap: anywhere;
  min-height: 1.5em;
}

.led {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ink-3);
  flex: none;
  transition: background 0.2s, box-shadow 0.2s;
}
.led.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.led.warn { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 22%, transparent); }
.led.err { background: var(--err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--err) 22%, transparent); }
.led.off { background: var(--ink-3); box-shadow: none; }
.led.pulse { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.switch {
  position: relative;
  width: 54px;
  height: 30px;
  flex: none;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface-3);
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}
.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ink-3);
  box-shadow: var(--sh-1);
  transition: transform 0.26s cubic-bezier(0.34, 1.52, 0.64, 1), background 0.2s;
}
.switch[aria-checked="true"] {
  background: color-mix(in srgb, var(--ok) 22%, transparent);
  border-color: color-mix(in srgb, var(--ok) 55%, transparent);
}
.switch[aria-checked="true"] .knob { transform: translateX(24px); background: var(--ok); }
.switch:disabled { opacity: 0.45; cursor: not-allowed; }

/* ══ Stat strip ═══════════════════════════════════════════════════════════ */

.stats {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.stat { background: var(--surface); padding: 14px 16px; }
.stat .k { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-3); }
.stat .v {
  margin-top: 5px;
  font-family: var(--display);
  font-size: 21px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.015em;
  line-height: 1.2;
}
.stat .v small { font-family: var(--sans); font-size: 12px; font-weight: 400; color: var(--ink-3); letter-spacing: 0; }

/* ══ Banner ═══════════════════════════════════════════════════════════════ */

.banner {
  display: none;
  gap: 13px;
  align-items: flex-start;
  border: 1px solid color-mix(in srgb, var(--err) 42%, var(--line));
  border-left-width: 3px;
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--err) 9%, var(--surface));
  padding: 15px 17px;
  margin-top: 22px;
  font-size: 13px;
  color: var(--ink);
}
.banner.show { display: flex; animation: rise 0.35s ease-out both; }
.banner strong {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--err);
}
.banner .led { margin-top: 5px; }

/* ══ Diagnostics ══════════════════════════════════════════════════════════ */

.issue {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  padding: 11px 0;
  border-top: 1px solid var(--line);
  font-size: 13px;
}
.issue:first-child { border-top: 0; padding-top: 0; }
.issue .sev {
  flex: none;
  margin-top: 1px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
}
.issue.error .sev { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); }
.issue.warning .sev { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.all-clear { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-2); }

/* ══ Table ════════════════════════════════════════════════════════════════ */

.scroller { overflow-x: auto; margin: 0 -20px; padding: 0 20px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th {
  text-align: left;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-3);
  padding: 0 14px 10px 0;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
/* Width hints so long endpoints get the room instead of breaking mid-word. */
thead th:nth-child(1) { width: 68px; }
thead th:nth-child(2) { width: 22%; }
thead th:nth-child(3) { width: 11%; }
thead th:nth-child(4) { width: 26%; }
thead th:nth-child(5) { width: 19%; }
thead th:nth-child(6) { width: 136px; }
tbody td { padding: 13px 14px 13px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: background 0.14s; }
tbody tr:hover td { background: var(--surface-2); }
tbody tr.flagged td { background: color-mix(in srgb, var(--err) 7%, transparent); }

.slot {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  background: var(--surface-3);
  border-radius: var(--r-sm);
  padding: 2px 7px;
  display: inline-block;
}
.name { font-weight: 550; font-size: 13.5px; }
.slug { color: var(--ink-3); font-size: 11.5px; font-family: var(--mono); overflow-wrap: anywhere; margin-top: 2px; }
.endpoint { color: var(--ink-2); font-size: 12px; font-family: var(--mono); overflow-wrap: anywhere; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 10.5px;
  letter-spacing: 0.03em;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--ink-2);
  background: var(--surface-2);
  padding: 2px 8px;
  white-space: nowrap;
}
.chip.key { border-color: color-mix(in srgb, var(--info) 45%, transparent); color: var(--info); background: color-mix(in srgb, var(--info) 9%, transparent); }
.chip.img { border-color: color-mix(in srgb, var(--ok) 45%, transparent); color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); }
.chip.think { border-color: color-mix(in srgb, var(--warn) 45%, transparent); color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); }
.chip.bad { border-color: color-mix(in srgb, var(--err) 45%, transparent); color: var(--err); background: color-mix(in srgb, var(--err) 9%, transparent); }

.row-actions { display: flex; gap: 6px; justify-content: flex-end; }
.verdict {
  display: none;
  margin-top: 7px;
  font-size: 11.5px;
  font-family: var(--mono);
  border-radius: var(--r-sm);
  padding: 3px 8px;
}
.verdict.ok, .verdict.bad, .verdict.busy { display: inline-block; }
.verdict.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 11%, transparent); }
.verdict.bad { color: var(--err); background: color-mix(in srgb, var(--err) 11%, transparent); }
.verdict.busy { color: var(--ink-3); background: var(--surface-3); }

/* ══ Buttons & inputs ═════════════════════════════════════════════════════ */

button {
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  padding: 7px 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.08s, box-shadow 0.15s;
}
button:hover:not(:disabled) { background: var(--surface-3); border-color: var(--ink-3); }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { opacity: 0.45; cursor: not-allowed; }

button.primary {
  background: var(--solid);
  color: var(--solid-ink);
  border-color: var(--solid);
  box-shadow: var(--sh-1);
}
button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--solid) 86%, var(--accent)); border-color: transparent; color: var(--solid-ink); }

button.ghost { background: transparent; border-color: var(--line); color: var(--ink-2); }
button.ghost:hover:not(:disabled) { background: var(--surface-3); color: var(--ink); }

button.danger { background: transparent; border-color: var(--line); color: var(--ink-2); }
button.danger:hover:not(:disabled) {
  color: var(--err);
  border-color: color-mix(in srgb, var(--err) 50%, transparent);
  background: color-mix(in srgb, var(--err) 9%, transparent);
}

button.tiny { padding: 4px 10px; font-size: 11.5px; border-radius: var(--r-sm); }
button.icon { padding: 6px; display: inline-grid; place-items: center; }
button.icon svg { width: 14px; height: 14px; display: block; }

.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; }
@media (max-width: 780px) { .toolbar { flex-wrap: wrap; } }

input[type="search"], input[type="text"], input[type="number"], select, textarea {
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  padding: 8px 11px;
  width: 100%;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
input::placeholder { color: var(--ink-3); }
input:hover:not(:disabled), select:hover, textarea:hover { border-color: var(--ink-3); }
input:disabled { opacity: 0.55; cursor: not-allowed; }
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input[type="checkbox"], input[type="radio"] { width: auto; accent-color: var(--accent); }

.search { position: relative; flex: 0 1 215px; min-width: 130px; }
.search input { padding-left: 31px; }
.search svg {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 13px;
  height: 13px;
  color: var(--ink-3);
  pointer-events: none;
}

label.inline {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  user-select: none;
}

/* ══ Log ══════════════════════════════════════════════════════════════════ */

.log-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.log {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  height: 340px;
  overflow: auto;
  padding: 14px 16px;
  margin: 0;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-2);
}
.log:empty::before { content: "Waiting for proxy output…"; color: var(--ink-3); font-style: italic; }
.log .l-error { color: var(--err); }
.log .l-warn { color: var(--warn); }
.log .l-info { color: var(--ink-2); }
.log .l-hit { background: color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 3px; color: var(--ink); }

/* ══ Paths footer ═════════════════════════════════════════════════════════ */

.paths { display: grid; gap: 10px; }
.path-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.path-row .k { flex: none; width: 74px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.path-row .v {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-2);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 6px 9px;
  overflow-wrap: anywhere;
}

/* ══ Dialog ═══════════════════════════════════════════════════════════════ */

dialog {
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
  background: var(--surface);
  color: var(--ink);
  padding: 0;
  width: min(680px, calc(100vw - 28px));
  box-shadow: var(--sh-3);
}
dialog::backdrop { background: rgba(8, 10, 13, 0.55); backdrop-filter: blur(3px); }
dialog[open] { animation: pop 0.2s cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes pop { from { opacity: 0; transform: translateY(8px) scale(0.985); } }

.dlg-head {
  padding: 18px 22px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.dlg-head h2 { margin: 0; font-family: var(--display); font-size: 18px; font-weight: 500; letter-spacing: -0.01em; }
.dlg-head .hint { margin-left: auto; }
.dlg-body { padding: 20px 22px; max-height: min(66vh, 620px); overflow-y: auto; }
.dlg-foot {
  padding: 15px 22px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  align-items: center;
  background: var(--surface-2);
  border-radius: 0 0 var(--r-xl) var(--r-xl);
}

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field.span { grid-column: 1 / -1; }
.field > label { font-size: 12px; font-weight: 550; color: var(--ink-2); }
.field .note { font-size: 11.5px; color: var(--ink-3); font-weight: 400; }
.field .req { color: var(--err); }
.warn-text { color: var(--err); }

.form-error { color: var(--err); font-size: 12.5px; min-height: 1.4em; margin-top: 14px; }
fieldset { border: 1px solid var(--line); border-radius: var(--r-lg); margin: 18px 0 0; padding: 16px 17px; background: var(--surface-2); }
legend { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); padding: 0 7px; }
.radios { display: flex; gap: 16px; flex-wrap: wrap; }

/* ══ Toasts ═══════════════════════════════════════════════════════════════ */

#toasts { position: fixed; right: 20px; bottom: 20px; z-index: 200; display: flex; flex-direction: column; gap: 10px; max-width: 380px; }
.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--ink-3);
  border-radius: var(--r-md);
  background: var(--surface);
  padding: 12px 15px;
  font-size: 12.5px;
  color: var(--ink);
  box-shadow: var(--sh-2);
  animation: slide 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.toast.ok { border-left-color: var(--ok); }
.toast.bad { border-left-color: var(--err); }
.toast.info { border-left-color: var(--info); }
@keyframes slide { from { opacity: 0; transform: translateX(16px); } }

.restart-note {
  margin-top: 14px;
  font-size: 12px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 32%, transparent);
  border-radius: var(--r-md);
  padding: 9px 12px;
}
.empty { color: var(--ink-3); font-size: 13px; padding: 26px 0; text-align: center; }

/* ══ Responsive ═══════════════════════════════════════════════════════════ */

@media (max-width: 900px) {
  /* The toolbar gets its own full-width row rather than wrapping one button. */
  .card-head .toolbar { width: 100%; }
  .card-head .search { flex: 1 1 auto; }

  .scroller { overflow-x: visible; margin: 0; padding: 0; }
  table, tbody, tr, td { display: block; width: 100%; }
  thead { display: none; }
  tbody tr {
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--surface-2);
    padding: 12px 14px;
    margin-bottom: 12px;
  }
  tbody tr:hover td, tbody tr.flagged td { background: transparent; }
  tbody td { border: 0; padding: 5px 0; display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; align-items: start; }
  tbody td::before {
    content: attr(data-label);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    padding-top: 2px;
  }
  tbody td .slot { justify-self: start; }
  .row-actions { justify-content: flex-start; grid-column: 2; }
}

@media (max-width: 640px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wrap { padding: 20px 16px 70px; }
  .topbar-inner { padding: 12px 16px; }
  .grid { grid-template-columns: 1fr; }
  .brand-sub { display: none; }
  #toasts { left: 16px; right: 16px; max-width: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"></div>

<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="mark" aria-hidden="true">
        <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
          <g class="orbit">
            <ellipse cx="16" cy="16" rx="14.2" ry="6.2" transform="rotate(-28 16 16)"
              stroke="currentColor" stroke-width="1.3" opacity="0.45"/>
            <circle cx="28.5" cy="9.4" r="2" fill="currentColor" opacity="0.8"/>
          </g>
          <circle cx="16" cy="16" r="5.4" fill="currentColor"/>
        </svg>
      </span>
      <span>
        <span class="wordmark">Antigravity</span>
        <span class="brand-sub">Model proxy console</span>
      </span>
    </div>

    <div class="topbar-right">
      <span class="pill"><span class="led off" id="pill-proxy-led"></span><span class="k">Proxy</span><b id="pill-proxy">—</b></span>
      <span class="pill"><span class="led off" id="pill-ide-led"></span><span class="k">IDE</span><b id="pill-ide">—</b></span>
      <div class="theme" role="group" aria-label="Colour theme">
        <button type="button" data-theme-set="light" aria-pressed="false" title="Light" aria-label="Light theme">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>
          </svg>
        </button>
        <button type="button" data-theme-set="dark" aria-pressed="false" title="Dark" aria-label="Dark theme">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z"/>
          </svg>
        </button>
        <button type="button" data-theme-set="auto" aria-pressed="false" title="Match system" aria-label="Match system theme">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</header>

<main class="wrap">

  <div class="banner" id="banner" role="alert">
    <span class="led err" aria-hidden="true"></span>
    <div><strong>Configuration conflict</strong><span id="banner-text"></span></div>
  </div>

  <section class="deck">
    <article class="card" style="--d:0">
      <div class="control-top">
        <div>
          <p class="eyebrow">Proxy server</p>
          <h2 class="control-state"><span class="led off" id="proxy-led" aria-hidden="true"></span><span id="proxy-state">—</span></h2>
        </div>
        <button class="switch" id="proxy-toggle" role="switch" aria-checked="false" aria-label="Proxy server">
          <span class="knob"></span>
        </button>
      </div>
      <p class="control-sub" id="proxy-sub"></p>
    </article>

    <article class="card" style="--d:1">
      <div class="control-top">
        <div>
          <p class="eyebrow">IDE routing</p>
          <h2 class="control-state"><span class="led off" id="ide-led" aria-hidden="true"></span><span id="ide-state">—</span></h2>
        </div>
        <button class="switch" id="ide-toggle" role="switch" aria-checked="false" aria-label="IDE routing through the proxy">
          <span class="knob"></span>
        </button>
      </div>
      <p class="control-sub" id="ide-sub"></p>
    </article>
  </section>

  <section class="stats" aria-label="At a glance">
    <div class="stat"><div class="k">Custom models</div><div class="v" id="stat-models">—</div></div>
    <div class="stat"><div class="k">Dropdown slots</div><div class="v" id="stat-slots">—</div></div>
    <div class="stat"><div class="k">Log on disk</div><div class="v" id="stat-log">—</div></div>
    <div class="stat"><div class="k">Platform</div><div class="v" id="stat-platform">—</div></div>
  </section>

  <section class="card" id="issues-panel" style="--d:2">
    <div class="card-head">
      <h2>Config checks</h2>
      <span class="hint" id="slot-usage"></span>
    </div>
    <div id="issues"></div>
  </section>

  <section class="card" id="subagent-panel" style="--d:2">
    <div class="card-head">
      <h2>Subagent model</h2>
      <span class="hint" id="subagent-types"></span>
    </div>
    <p class="control-sub">
      Some steps run on a model the IDE picks for itself, not the one in the dropdown — page
      inspection and commit messages among them. Those are Google models, so while the IDE routes
      through this proxy they fail with <b>429 Resource Exhausted</b>. Pick a custom model to serve
      them instead. Takes effect on the next request; no IDE restart.
    </p>
    <div class="field span">
      <label for="subagent-select">Serve these requests with</label>
      <select id="subagent-select"></select>
      <span class="note" id="subagent-note"></span>
    </div>
  </section>

  <section class="card" style="--d:3">
    <div class="card-head">
      <h2>Custom models</h2>
      <div class="toolbar">
        <div class="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
          </svg>
          <input type="search" id="model-filter" placeholder="Filter models…" aria-label="Filter models">
        </div>
        <button class="ghost" id="export-btn">Export</button>
        <button class="ghost" id="import-btn">Import</button>
        <button class="primary" id="add-btn">Add model</button>
        <input type="file" id="import-file" accept="application/json,.json" class="sr" tabindex="-1">
      </div>
    </div>
    <div class="scroller">
      <table>
        <thead>
          <tr>
            <th>Slot</th><th>Model</th><th>Provider</th><th>Endpoint</th><th>Flags</th><th><span class="sr">Actions</span></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="empty" id="models-empty" hidden>No custom models yet. Add one to have it appear in the IDE dropdown.</div>
    <div class="restart-note" id="restart-note" hidden>Restart the IDE fully for dropdown changes to take effect.</div>
  </section>

  <section class="card" style="--d:4">
    <div class="card-head">
      <h2>Proxy log</h2>
      <span class="hint" id="log-size"></span>
    </div>
    <div class="log-bar">
      <div class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
        </svg>
        <input type="search" id="log-filter" placeholder="Filter lines…" aria-label="Filter log lines">
      </div>
      <label class="inline"><input type="checkbox" id="log-follow" checked> Follow</label>
      <label class="inline"><input type="checkbox" id="log-errors"> Errors only</label>
      <button class="ghost tiny" id="log-clear">Clear view</button>
    </div>
    <pre class="log" id="log" tabindex="0" aria-label="Proxy log"></pre>
  </section>

  <section class="card" style="--d:5">
    <div class="card-head"><h2>Files</h2></div>
    <div class="paths">
      <div class="path-row">
        <span class="k">Models</span>
        <span class="v" id="path-models">—</span>
        <button class="ghost icon" data-copy="path-models" title="Copy path" aria-label="Copy models path">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>
          </svg>
        </button>
      </div>
      <div class="path-row">
        <span class="k">Log</span>
        <span class="v" id="path-log">—</span>
        <button class="ghost icon" data-copy="path-log" title="Copy path" aria-label="Copy log path">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>
          </svg>
        </button>
      </div>
    </div>
  </section>

</main>

<dialog id="dlg">
  <form id="form" method="dialog">
    <div class="dlg-head">
      <h2 id="dlg-title">Add model</h2>
      <span class="hint" id="dlg-slot"></span>
      <button type="button" class="ghost icon" id="dlg-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6 6 18"/>
        </svg>
      </button>
    </div>
    <div class="dlg-body">
      <div class="grid">
        <div class="field span">
          <label for="f-display">Display name <span class="note">— the dropdown label</span></label>
          <input type="text" id="f-display" placeholder="Claude Opus 5" autocomplete="off">
          <span class="note" id="slot-preview"></span>
        </div>
        <div class="field">
          <label for="f-name">Name <span class="req">*</span></label>
          <input type="text" id="f-name" placeholder="models/claude-opus-5" required autocomplete="off">
          <span class="note">Unique internal id, starts with models/</span>
        </div>
        <div class="field">
          <label for="f-provider">Provider <span class="req">*</span></label>
          <select id="f-provider" required></select>
          <span class="note" id="provider-note"></span>
        </div>
        <div class="field span">
          <label for="f-url">API URL <span class="req">*</span></label>
          <input type="text" id="f-url" placeholder="https://api.anthropic.com/v1/messages" required autocomplete="off">
          <span class="note">Full path, not just the host</span>
        </div>
        <div class="field span">
          <label for="f-ext">External model name</label>
          <input type="text" id="f-ext" placeholder="claude-opus-5" autocomplete="off">
          <span class="note">Exact id sent to the provider. For a gateway, its alias.</span>
        </div>
        <div class="field span">
          <label for="f-desc">Description</label>
          <input type="text" id="f-desc" autocomplete="off">
        </div>
      </div>

      <fieldset>
        <legend>API key</legend>
        <div class="radios" id="key-modes">
          <label class="inline"><input type="radio" name="keyAction" value="keep" checked> Keep</label>
          <label class="inline"><input type="radio" name="keyAction" value="set"> Replace</label>
          <label class="inline"><input type="radio" name="keyAction" value="clear"> Remove</label>
        </div>
        <div class="field" style="margin-top:13px">
          <input type="text" id="f-key" placeholder="sk-..." autocomplete="off" spellcheck="false" disabled>
          <span class="note" id="key-note"></span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Advanced</legend>
        <div class="grid">
          <div class="field">
            <label for="f-timeout">Timeout (ms)</label>
            <input type="number" id="f-timeout" min="1000" step="1000" placeholder="120000">
          </div>
          <div class="field">
            <label for="f-retries">Max retries</label>
            <input type="number" id="f-retries" min="0" max="10" placeholder="3">
          </div>
          <div class="field">
            <label for="f-temp-mode">Temperature</label>
            <select id="f-temp-mode">
              <option value="">Auto — let the translator decide</option>
              <option value="fixed">Fixed value</option>
              <option value="omit">Never send one</option>
            </select>
          </div>
          <div class="field" id="temp-value-field" hidden>
            <label for="f-temp">Value</label>
            <input type="number" id="f-temp" min="0" max="2" step="0.1" placeholder="0.7">
          </div>
          <div class="field span">
            <span class="note" id="temp-note"></span>
          </div>
          <div class="field span">
            <label for="f-images">Image support</label>
            <select id="f-images">
              <option value="">Auto-detect from the model name</option>
              <option value="true">Force on</option>
              <option value="false">Force off</option>
            </select>
            <span class="note">Set this when the IDE wrongly says the model cannot take images.</span>
          </div>
          <div class="field span">
            <label class="inline"><input type="checkbox" id="f-insecure"> Allow unauthorized TLS (self-signed only)</label>
          </div>
        </div>
      </fieldset>

      <div class="form-error" id="form-error" role="alert"></div>
    </div>
    <div class="dlg-foot">
      <button type="button" class="ghost" id="dlg-cancel">Cancel</button>
      <button type="button" class="primary" id="dlg-save">Save model</button>
    </div>
  </form>
</dialog>

<div id="toasts" aria-live="polite" aria-atomic="false"></div>

<script>
(function () {
  'use strict';

  var TOKEN = ${JSON.stringify(options.token)};
  var PROVIDERS = ['openai','anthropic','google','ollama','custom','openrouter','codex','deepseek','groq','mistral','cerebras','kimi','fireworks','lmstudio','llamacpp','nvidia'];
  var PROVIDER_HINT = {
    ollama: 'No API key needed. URL auto-normalizes.',
    anthropic: 'Anthropic Messages format, x-api-key header.',
    google: 'Google format, x-goog-api-key header.',
    openrouter: 'OpenAI format plus referer headers.',
    codex: 'OpenAI Responses API (/responses), bearer token. Use for kie.ai Codex.'
  };
  // Display only — the stored value is always the lowercase id.
  var PROVIDER_LABEL = {
    openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', ollama: 'Ollama',
    custom: 'Custom', openrouter: 'OpenRouter', codex: 'Responses API (Codex)',
    deepseek: 'DeepSeek', groq: 'Groq',
    mistral: 'Mistral', cerebras: 'Cerebras', kimi: 'Kimi', fireworks: 'Fireworks',
    lmstudio: 'LM Studio', llamacpp: 'llama.cpp', nvidia: 'NVIDIA'
  };
  function providerLabel(id) { return PROVIDER_LABEL[id] || id; }

  var state = { status: null, snapshot: null, logOffset: -1, editing: null, busy: false, filter: '' };
  var el = function (id) { return document.getElementById(id); };

  // ── theme ───────────────────────────────────────────────

  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(pref) {
    var dark = pref === 'dark' || (pref === 'auto' && media.matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-pref', pref);
    document.querySelectorAll('[data-theme-set]').forEach(function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-theme-set') === pref ? 'true' : 'false');
    });
  }

  function themePref() {
    return document.documentElement.getAttribute('data-theme-pref') || 'auto';
  }

  function setTheme(pref) {
    try { localStorage.setItem('antigravity.theme', pref); } catch (e) { /* private mode */ }
    applyTheme(pref);
  }

  // ── plumbing ────────────────────────────────────────────

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(path, method, body) {
    return fetch(path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Antigravity-Token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : 'Request failed (' + res.status + ')');
        return data;
      });
    });
  }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || 'info');
    node.textContent = message;
    el('toasts').appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .3s';
      node.style.opacity = '0';
      setTimeout(function () { node.remove(); }, 320);
    }, kind === 'bad' ? 8000 : 4200);
  }

  function noteRestart(needed) {
    if (needed) el('restart-note').hidden = false;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for the odd browser that has no async clipboard on http.
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } finally { area.remove(); }
    return Promise.resolve();
  }

  // ── control panel ───────────────────────────────────────

  function applyStatus(status) {
    state.status = status;
    var running = status.proxy.running;

    el('proxy-led').className = 'led ' + (running ? 'on' : 'off');
    el('proxy-state').textContent = running ? 'Running' : 'Stopped';
    el('proxy-sub').textContent = running ? status.proxy.url : 'Not listening';
    el('proxy-toggle').setAttribute('aria-checked', running ? 'true' : 'false');
    el('pill-proxy-led').className = 'led ' + (running ? 'on' : 'off');
    el('pill-proxy').textContent = running ? 'on' : 'off';

    var routed = status.ide.routing === 'proxy';
    var conflict = Boolean(status.warning);
    el('ide-led').className = 'led ' + (conflict ? 'err' : routed ? 'on' : 'off');
    el('ide-state').textContent = routed ? 'Through proxy' : 'Direct to Google';
    el('ide-toggle').setAttribute('aria-checked', routed ? 'true' : 'false');
    el('ide-toggle').disabled = !status.ide.found;
    el('pill-ide-led').className = 'led ' + (conflict ? 'err' : routed ? 'on' : 'off');
    el('pill-ide').textContent = routed ? 'proxy' : 'google';

    if (!status.ide.found) {
      el('ide-sub').textContent = 'No IDE settings.json found — set ANTIGRAVITY_IDE_SETTINGS.';
    } else {
      var where = status.ide.filePath.split(/[\\\\/]/).slice(-3).join('/');
      el('ide-sub').textContent = status.ide.settingKey + ' in ' + where +
        (status.ide.url && !routed ? ' (kept: ' + status.ide.url + ')' : '');
    }

    el('banner').className = 'banner' + (conflict ? ' show' : '');
    el('banner-text').textContent = status.warning || '';
    el('stat-platform').textContent = status.platform;
    el('path-models').textContent = status.paths.models;
    el('path-log').textContent = status.paths.log;
  }

  function toggleProxy() {
    if (state.busy) return;
    var running = state.status && state.status.proxy.running;
    var goingDown = running;
    setBusy(true);
    el('proxy-led').className = 'led warn pulse';
    api(goingDown ? '/api/proxy/stop' : '/api/proxy/start', 'POST', {})
      .then(function (data) {
        applyStatus(data.status);
        toast(data.message, data.status.warning ? 'bad' : 'ok');
      })
      .catch(function (err) { toast(err.message, 'bad'); return refreshStatus(); })
      .then(function () { setBusy(false); });
  }

  function toggleIde() {
    if (state.busy) return;
    var routed = state.status && state.status.ide.routing === 'proxy';
    setBusy(true);
    el('ide-led').className = 'led warn pulse';
    api(routed ? '/api/ide/disable' : '/api/ide/enable', 'POST', {})
      .then(function (data) {
        applyStatus(data.status);
        toast(data.message, 'ok');
        if (data.restartRequired) toast('Quit and reopen the IDE for this to take effect.', 'info');
      })
      .catch(function (err) { toast(err.message, 'bad'); return refreshStatus(); })
      .then(function () { setBusy(false); });
  }

  function setBusy(value) {
    state.busy = value;
    el('proxy-toggle').disabled = value;
    el('ide-toggle').disabled = value || !(state.status && state.status.ide.found);
  }

  function refreshStatus() {
    return api('/api/status').then(applyStatus).catch(function (err) {
      el('pill-proxy').textContent = 'offline';
      el('pill-proxy-led').className = 'led err';
      toastOnce('disconnected', 'Console disconnected — ' + err.message);
    });
  }

  var toasted = {};
  function toastOnce(key, message) {
    if (toasted[key]) return;
    toasted[key] = true;
    toast(message, 'bad');
    setTimeout(function () { toasted[key] = false; }, 30000);
  }

  // ── models ──────────────────────────────────────────────

  function applySnapshot(snapshot) {
    state.snapshot = snapshot;
    renderIssues(snapshot);
    renderRows(snapshot);
    el('slot-usage').textContent = snapshot.slotsUsed + ' of ' + snapshot.slotsTotal + ' dropdown slots used';
    el('stat-models').textContent = snapshot.models.length;
    el('stat-slots').innerHTML = snapshot.slotsUsed + ' <small>of ' + snapshot.slotsTotal + '</small>';
    renderSubagent(snapshot);
  }

  function renderSubagent(snapshot) {
    var select = el('subagent-select');
    var current = snapshot.subagentEnvOverride || snapshot.subagentModel || '';

    var options = ['<option value="">Google (default — fails while routed here)</option>'];
    snapshot.models.forEach(function (model) {
      // Value is the model name, the identifier the proxy matches first and the
      // one the config file documents.
      var label = model.displayName || model.name;
      if (!model.capabilities.supportsImages) label += ' — no image support';
      options.push('<option value="' + esc(model.name) + '"' +
        (model.name === current ? ' selected' : '') + '>' + esc(label) + '</option>');
    });
    select.innerHTML = options.join('');

    // An env var beats the file, so editing here would change nothing.
    var overridden = Boolean(snapshot.subagentEnvOverride);
    select.disabled = overridden;

    var types = (snapshot.subagentRequestTypes || []).join(', ');
    el('subagent-types').textContent = types ? 'rerouting: ' + types : '';

    var note;
    if (overridden) {
      note = 'Set by ANTIGRAVITY_SUBAGENT_MODEL in the environment, which overrides this file. ' +
        'Unset it to choose here.';
    } else if (!snapshot.subagentModel) {
      note = 'Off. These requests go to Google and will 429 while IDE routing is on.';
    } else if (!selectedSupportsImages(snapshot)) {
      // Page inspection sends screenshots; a text-only model returns nonsense
      // rather than an error, which is harder to diagnose than a 429.
      note = 'This model is reported as text-only. Page inspection sends screenshots — ' +
        'set supportsImages on it, or pick a model that handles images.';
    } else {
      note = '';
    }
    el('subagent-note').textContent = note;
  }

  function selectedSupportsImages(snapshot) {
    var match = snapshot.models.filter(function (m) { return m.name === snapshot.subagentModel; })[0];
    return !match || match.capabilities.supportsImages;
  }

  function renderIssues(snapshot) {
    var host = el('issues');
    if (!snapshot.issues.length) {
      host.innerHTML = '<div class="all-clear"><span class="led on"></span>' +
        'No duplicate names, no slot collisions, every entry valid.</div>';
      return;
    }
    host.innerHTML = snapshot.issues.map(function (issue) {
      return '<div class="issue ' + issue.level + '">' +
        '<span class="sev">' + issue.level + '</span>' +
        '<span>' + esc(issue.message) + '</span></div>';
    }).join('');
  }

  function flagged(snapshot, index) {
    return snapshot.issues.some(function (issue) {
      return issue.level === 'error' && issue.models.indexOf(index) !== -1;
    });
  }

  function matchesFilter(model) {
    if (!state.filter) return true;
    var hay = [model.displayName, model.name, model.provider, model.apiUrl, model.externalModelName]
      .join(' ').toLowerCase();
    return hay.indexOf(state.filter) !== -1;
  }

  function renderRows(snapshot) {
    var body = el('rows');
    var visible = snapshot.models.filter(matchesFilter);
    var empty = el('models-empty');

    empty.hidden = visible.length > 0;
    empty.textContent = snapshot.models.length === 0
      ? 'No custom models yet. Add one to have it appear in the IDE dropdown.'
      : 'No model matches that filter.';

    body.innerHTML = visible.map(function (model) {
      var chips = [];
      if (!model.valid) chips.push('<span class="chip bad">invalid</span>');
      if (model.capabilities.isThinking) chips.push('<span class="chip think">thinking</span>');
      if (model.capabilities.supportsImages) {
        chips.push('<span class="chip img">images' + (model.supportsImages !== null ? ' set' : '') + '</span>');
      }
      if (model.temperature !== null) {
        chips.push('<span class="chip">' + (model.temperature === 'omit' ? 'no temp' : 'temp ' + esc(String(model.temperature))) + '</span>');
      }
      if (model.hasKey) chips.push('<span class="chip key">key ' + esc(model.keyPreview) + '</span>');
      else chips.push('<span class="chip">no key</span>');
      if (model.allowUnauthorized) chips.push('<span class="chip bad">insecure TLS</span>');

      return '<tr class="' + (flagged(snapshot, model.index) ? 'flagged' : '') + '" data-index="' + model.index + '">' +
        '<td data-label="Slot"><span class="slot">M' + model.slot + '</span></td>' +
        '<td data-label="Model"><div><div class="name">' + esc(model.displayName || model.name) + '</div>' +
          '<div class="slug">' + esc(model.name) + '</div>' +
          '<div class="slug">' + esc(model.slug) + '</div>' +
          '<span class="verdict" data-verdict="' + model.index + '"></span></div></td>' +
        '<td data-label="Provider"><div><span>' + esc(providerLabel(model.provider)) + '</span>' +
          '<div class="slug">' + esc(model.externalModelName || '—') + '</div></div></td>' +
        '<td data-label="Endpoint" class="endpoint">' + esc(model.apiUrl) + '</td>' +
        '<td data-label="Flags"><div class="chips">' + chips.join('') + '</div></td>' +
        '<td data-label=""><div class="row-actions">' +
          '<button class="ghost tiny" data-act="test">Test</button>' +
          '<button class="ghost tiny" data-act="edit">Edit</button>' +
          '<button class="danger tiny" data-act="del">Delete</button>' +
        '</div></td></tr>';
    }).join('');
  }

  function refreshModels() {
    return api('/api/models').then(applySnapshot).catch(function (err) { toast(err.message, 'bad'); });
  }

  function modelAt(index) {
    if (!state.snapshot) return null;
    for (var i = 0; i < state.snapshot.models.length; i++) {
      if (state.snapshot.models[i].index === index) return state.snapshot.models[i];
    }
    return null;
  }

  function runTest(index) {
    var model = modelAt(index);
    if (!model) return;
    var slot = document.querySelector('[data-verdict="' + index + '"]');
    slot.className = 'verdict busy';
    slot.textContent = 'testing…';

    api('/api/models/test', 'POST', { index: index, expectedName: model.name })
      .then(function (result) {
        slot.className = 'verdict ' + (result.ok ? 'ok' : 'bad');
        var bits = [result.ok ? '✓' : '✕', result.summary];
        if (result.status) bits.push('· HTTP ' + result.status);
        bits.push('· ' + result.durationMs + 'ms');
        slot.textContent = bits.join(' ');
        if (result.detail && !result.ok) toast(result.summary + ' — ' + result.detail, 'bad');
      })
      .catch(function (err) {
        slot.className = 'verdict bad';
        slot.textContent = '✕ ' + err.message;
      });
  }

  function removeModel(index) {
    var model = modelAt(index);
    if (!model) return;
    var label = model.displayName || model.name;
    if (!window.confirm('Delete "' + label + '"?\\n\\nA backup of custom_models.json is written first.')) return;

    api('/api/models/delete', 'POST', { index: index, expectedName: model.name })
      .then(function (data) {
        applySnapshot(data.models);
        noteRestart(data.restartRequired);
        toast('Deleted "' + label + '".', 'ok');
      })
      .catch(function (err) { toast(err.message, 'bad'); refreshModels(); });
  }

  // ── form ────────────────────────────────────────────────

  function fillProviders() {
    el('f-provider').innerHTML = PROVIDERS.map(function (p) {
      return '<option value="' + p + '">' + esc(providerLabel(p)) + '</option>';
    }).join('');
  }

  function slotOf(displayName) {
    var input = String(displayName || 'custom-model').toLowerCase();
    var hash = 5381;
    for (var i = 0; i < input.length; i++) {
      hash = (hash << 5) + hash + input.charCodeAt(i);
      hash = hash & hash;
    }
    return 400 + (Math.abs(hash) % 200);
  }

  function updateSlotPreview() {
    var display = el('f-display').value || el('f-name').value;
    if (!display) { el('slot-preview').textContent = ''; el('dlg-slot').textContent = ''; return; }
    var slot = slotOf(display);
    var clash = null;
    if (state.snapshot) {
      for (var i = 0; i < state.snapshot.models.length; i++) {
        var m = state.snapshot.models[i];
        if (m.slot === slot && (!state.editing || m.index !== state.editing.index)) { clash = m; break; }
      }
    }
    el('dlg-slot').textContent = 'Slot M' + slot;
    el('slot-preview').innerHTML = clash
      ? '<span class="warn-text">Slot M' + slot + ' already taken by "' + esc(clash.displayName || clash.name) + '" — rename to avoid a collision.</span>'
      : 'Dropdown slot M' + slot + ' — free.';
  }

  function keyModeChanged() {
    var mode = document.querySelector('input[name="keyAction"]:checked').value;
    el('f-key').disabled = mode !== 'set';
    if (mode !== 'set') el('f-key').value = '';
    el('key-note').textContent =
      mode === 'set' ? 'Stored base64-encoded, which is obfuscation and not encryption.'
      : mode === 'clear' ? 'The stored key will be removed.'
      : state.editing && state.editing.hasKey ? 'Keeping the existing key (' + state.editing.keyPreview + ').'
      : 'No key stored. Local providers such as Ollama need none.';
  }

  function openForm(model) {
    state.editing = model || null;
    el('dlg-title').textContent = model ? 'Edit model' : 'Add model';
    el('form-error').textContent = '';

    el('f-display').value = model ? model.displayName : '';
    el('f-name').value = model ? model.name : 'models/';
    el('f-provider').value = model ? model.provider : 'openai';
    el('f-url').value = model ? model.apiUrl : '';
    el('f-ext').value = model ? model.externalModelName : '';
    el('f-desc').value = model ? model.description : '';
    el('f-timeout').value = model && model.timeout ? model.timeout : '';
    el('f-retries').value = model && model.maxRetries !== null ? model.maxRetries : '';
    var temp = model ? model.temperature : null;
    el('f-temp-mode').value = temp === null || temp === undefined ? '' : temp === 'omit' ? 'omit' : 'fixed';
    el('f-temp').value = typeof temp === 'number' ? temp : '';
    tempModeChanged();
    el('f-images').value = model && model.supportsImages !== null ? String(model.supportsImages) : '';
    el('f-insecure').checked = Boolean(model && model.allowUnauthorized);

    var keep = document.querySelector('input[name="keyAction"][value="keep"]');
    keep.checked = true;
    document.querySelectorAll('input[name="keyAction"]').forEach(function (radio) {
      // "keep" is meaningless when creating; default to setting a key instead.
      radio.parentElement.style.display = !model && radio.value === 'keep' ? 'none' : '';
    });
    if (!model) document.querySelector('input[name="keyAction"][value="set"]').checked = true;

    keyModeChanged();
    providerChanged();
    updateSlotPreview();
    el('dlg').showModal();
    el('f-display').focus();
  }

  // Auto / fixed / omit. Only "fixed" carries a number with it.
  function tempModeChanged() {
    var mode = el('f-temp-mode').value;
    el('temp-value-field').hidden = mode !== 'fixed';
    el('temp-note').textContent = mode === 'omit'
      ? 'No temperature is sent, so the route applies its own. Use this for reasoning routes that reject the field.'
      : mode === 'fixed'
        ? 'Sent on every request, overriding the default the translator would pick.'
        : 'Reasoning models get none; everything else gets 0.7 unless the IDE asks for another.';
  }

  /** Reads the temperature controls into the value the API stores. */
  function temperatureInput() {
    var mode = el('f-temp-mode').value;
    if (mode === 'omit') return 'omit';
    if (mode !== 'fixed') return undefined;
    var raw = el('f-temp').value;
    return raw === '' ? undefined : Number(raw);
  }

  function providerChanged() {
    var provider = el('f-provider').value;
    el('provider-note').textContent = PROVIDER_HINT[provider] || 'OpenAI chat format, bearer token.';
  }

  function save() {
    var mode = document.querySelector('input[name="keyAction"]:checked').value;
    var images = el('f-images').value;
    var payload = {
      name: el('f-name').value.trim(),
      provider: el('f-provider').value,
      apiUrl: el('f-url').value.trim(),
      displayName: el('f-display').value.trim(),
      description: el('f-desc').value.trim(),
      externalModelName: el('f-ext').value.trim(),
      timeout: el('f-timeout').value ? Number(el('f-timeout').value) : undefined,
      maxRetries: el('f-retries').value ? Number(el('f-retries').value) : undefined,
      temperature: temperatureInput(),
      allowUnauthorized: el('f-insecure').checked,
      supportsImages: images === '' ? undefined : images === 'true',
      keyAction: mode,
      apiKey: mode === 'set' ? el('f-key').value.trim() : undefined
    };

    if (!payload.name || !payload.provider || !payload.apiUrl) {
      el('form-error').textContent = 'Name, provider and API URL are all required.';
      return;
    }

    var editing = state.editing;
    if (editing) {
      payload.index = editing.index;
      payload.expectedName = editing.name;
    }

    el('dlg-save').disabled = true;
    api(editing ? '/api/models/update' : '/api/models/create', 'POST', payload)
      .then(function (data) {
        applySnapshot(data.models);
        noteRestart(data.restartRequired);
        toast(data.message, 'ok');
        el('dlg').close();
      })
      .catch(function (err) { el('form-error').textContent = err.message; })
      .then(function () { el('dlg-save').disabled = false; });
  }

  // ── import / export ─────────────────────────────────────

  function doExport() {
    api('/api/export').then(function (data) {
      var text = JSON.stringify({ models: data.models }, null, 2);
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'custom_models.export.json';
      link.click();
      URL.revokeObjectURL(url);
      toast(data.strippedKeys
        ? 'Exported. ' + data.strippedKeys + ' API key(s) stripped — safe to share.'
        : 'Exported.', 'ok');
    }).catch(function (err) { toast(err.message, 'bad'); });
  }

  function doImport(file) {
    if (!file) return;
    if (!window.confirm('Import "' + file.name + '"?\\n\\nThis REPLACES your current model list. A backup is written first.')) return;

    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { toast('That file is not valid JSON.', 'bad'); return; }

      api('/api/import', 'POST', parsed)
        .then(function (data) {
          applySnapshot(data.models);
          noteRestart(data.restartRequired);
          toast(data.message, 'ok');
          (data.skipped || []).forEach(function (s) { toast('Skipped "' + s.name + '": ' + s.reason, 'bad'); });
        })
        .catch(function (err) { toast(err.message, 'bad'); });
    };
    reader.readAsText(file);
  }

  // ── log ─────────────────────────────────────────────────

  var logLines = [];

  function classify(line) {
    if (/\\[ERROR\\]/.test(line)) return 'l-error';
    if (/\\[WARN\\]/.test(line)) return 'l-warn';
    return 'l-info';
  }

  function renderLog() {
    var needle = el('log-filter').value.trim().toLowerCase();
    var onlyErrors = el('log-errors').checked;
    var view = el('log');
    var atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;

    var html = logLines.filter(function (line) {
      if (onlyErrors && !/\\[(ERROR|WARN)\\]/.test(line)) return false;
      if (needle && line.toLowerCase().indexOf(needle) === -1) return false;
      return true;
    }).map(function (line) {
      var cls = classify(line);
      var text = esc(line);
      if (needle) {
        // Highlight matches without regex-escaping the needle by hand.
        var lower = text.toLowerCase();
        var at = lower.indexOf(needle);
        if (at !== -1) {
          text = text.slice(0, at) + '<span class="l-hit">' + text.slice(at, at + needle.length) +
            '</span>' + text.slice(at + needle.length);
        }
      }
      return '<span class="' + cls + '">' + text + '</span>';
    }).join('\\n');

    view.innerHTML = html;
    if (el('log-follow').checked && atBottom) view.scrollTop = view.scrollHeight;
  }

  function pollLog() {
    api('/api/log?offset=' + state.logOffset)
      .then(function (chunk) {
        if (!chunk.exists) {
          el('log-size').textContent = 'no log file yet';
          el('stat-log').innerHTML = '0 <small>KB</small>';
          return;
        }
        if (chunk.rotated) { logLines = []; toast('Log rotated — view reset.', 'info'); }
        if (chunk.text) {
          var incoming = chunk.text.split(/\\r?\\n/).filter(function (l) { return l.trim() !== ''; });
          logLines = logLines.concat(incoming);
          // Keep the DOM bounded on a busy proxy.
          if (logLines.length > 2000) logLines = logLines.slice(-2000);
          renderLog();
        }
        state.logOffset = chunk.offset;
        var kb = Math.round(chunk.size / 1024);
        el('log-size').textContent = kb + ' KB on disk';
        el('stat-log').innerHTML = kb + ' <small>KB</small>';
      })
      .catch(function () { /* transient: the next poll will retry */ });
  }

  // ── wiring ──────────────────────────────────────────────

  applyTheme(themePref());
  media.addEventListener('change', function () {
    if (themePref() === 'auto') applyTheme('auto');
  });
  document.querySelectorAll('[data-theme-set]').forEach(function (button) {
    button.addEventListener('click', function () { setTheme(button.getAttribute('data-theme-set')); });
  });

  el('proxy-toggle').addEventListener('click', toggleProxy);
  el('ide-toggle').addEventListener('click', toggleIde);
  el('add-btn').addEventListener('click', function () { openForm(null); });
  el('subagent-select').addEventListener('change', function () {
    var value = el('subagent-select').value;
    api('/api/subagent', 'POST', { model: value })
      .then(function (data) {
        toast(data.message, 'ok');
        applySnapshot(data.models);
      })
      .catch(function (err) { toast(err.message, 'bad'); return refreshModels(); });
  });
  el('export-btn').addEventListener('click', doExport);
  el('import-btn').addEventListener('click', function () { el('import-file').click(); });
  el('import-file').addEventListener('change', function (e) {
    doImport(e.target.files[0]);
    e.target.value = '';
  });

  el('model-filter').addEventListener('input', function (e) {
    state.filter = e.target.value.trim().toLowerCase();
    if (state.snapshot) renderRows(state.snapshot);
  });

  el('rows').addEventListener('click', function (e) {
    var button = e.target.closest('button[data-act]');
    if (!button) return;
    var index = Number(button.closest('tr').getAttribute('data-index'));
    var act = button.getAttribute('data-act');
    if (act === 'test') runTest(index);
    else if (act === 'edit') openForm(modelAt(index));
    else if (act === 'del') removeModel(index);
  });

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = el(button.getAttribute('data-copy')).textContent;
      copyText(text).then(function () { toast('Path copied.', 'ok'); })
        .catch(function () { toast('Could not copy — select the path instead.', 'bad'); });
    });
  });

  el('dlg-save').addEventListener('click', save);
  el('dlg-cancel').addEventListener('click', function () { el('dlg').close(); });
  el('dlg-close').addEventListener('click', function () { el('dlg').close(); });
  el('f-display').addEventListener('input', updateSlotPreview);
  el('f-name').addEventListener('input', updateSlotPreview);
  el('f-provider').addEventListener('change', providerChanged);
  el('f-temp-mode').addEventListener('change', tempModeChanged);
  el('key-modes').addEventListener('change', keyModeChanged);
  el('log-filter').addEventListener('input', renderLog);
  el('log-errors').addEventListener('change', renderLog);
  el('log-clear').addEventListener('click', function () { logLines = []; renderLog(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && document.activeElement === document.body) {
      e.preventDefault();
      openForm(null);
    }
    if (e.key === '/' && document.activeElement === document.body) {
      e.preventDefault();
      el('model-filter').focus();
    }
  });

  fillProviders();
  refreshStatus();
  refreshModels();
  pollLog();
  setInterval(refreshStatus, 5000);
  setInterval(pollLog, 2000);
})();
</script>
</body>
</html>`;
}
