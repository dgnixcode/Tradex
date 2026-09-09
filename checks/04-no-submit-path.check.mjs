// 04-no-submit-path — plan/phase-04 T04.7 (the money-critical UI invariant).
//
// The trade ticket's defining property is a NEGATIVE one: "no code path submits a
// trade from this screen". A negative property is exactly what a browser test is
// bad at — you cannot click a button that should not exist. So it is proven the
// way the ticker ban is proven: a source scan over the whole web app, in the CI
// gate, that fails if any send/place path appears. A component cannot grow a
// send path without turning this red.
//
// What the web app IS allowed to call: the two planning endpoints, /preview and
// /confirm. Confirm carries only the preview token — whether the server then
// dry-runs (rung 0) or REALLY sends (the Phase-08 engine, gated on server-side
// submit/resolve ports) is a server decision the browser never makes, so this
// client surface is unchanged by Phase 08. What it must NEVER contain: a call
// that places or sends an order, or a fetch to any endpoint other than the
// read/preview/confirm surface.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = join(root, 'apps', 'web', 'src');

/** Recursively collect every .ts/.tsx file under a directory. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

// Anything that would mean "send/place a real order" from the browser.
const FORBIDDEN = [
  /placeOrder/i,
  /sendOrder/i,
  /\/place\b/i,
  /\/orders\/create/i,
  /\bexecuteTrade\b/i,
  /\/execute\b/i,
  /\bsubmitOrder\b/i,
];

export async function run(assert) {
  // The check is meaningful only if the app exists; if the scaffold is absent the
  // check must FAIL loudly rather than pass vacuously — a missing ticket cannot
  // be said to have "no submit path".
  assert(existsSync(webSrc), 'apps/web/src must exist for the no-submit-path invariant to mean anything');

  const files = collect(webSrc);
  assert(files.length > 0, 'the web app has no source files to scan');

  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(root.length + 1).replace(/\\/g, '/');
    for (const pat of FORBIDDEN) {
      assert(!pat.test(code), `${rel} contains a forbidden send/place path (${pat}) — the ticket must not submit a trade (T04.7)`);
    }
  }

  // The api client is the only place a network call is defined. It must expose
  // preview and confirm, and it must NOT export anything that looks like a send.
  const apiFile = join(webSrc, 'api.ts');
  assert(existsSync(apiFile), 'apps/web/src/api.ts must exist — it is the one place network calls are defined');
  const api = stripComments(readFileSync(apiFile, 'utf8'));
  assert(/previewTrade/.test(api), 'the api client must expose previewTrade');
  assert(/confirmTrade/.test(api), 'the api client must expose confirmTrade');
  // Every endpoint the client declares must be on the allowed surface — the
  // public auth routes, the dashboard reads, and the preview/confirm planning
  // routes — never a bare /orders POST or a place endpoint. Two call shapes are
  // scanned so nothing hides: the string passed to the request() helper (the
  // planning surface) AND raw fetch('/api/…') calls (the auth surface). The
  // helper's own `/api${path}` base has a '$' right after /api, so its empty
  // capture is filtered out rather than matched.
  const fromHelper = [...api.matchAll(/request<[^>]*>\(\s*[`']([^`'$]*)/g)].map((m) => m[1]);
  const fromRawFetch = [...api.matchAll(/fetch\(\s*['`]\/api([^'`$]*)/g)].map((m) => m[1]);
  const endpoints = [...fromHelper, ...fromRawFetch].filter((p) => p !== '');
  assert(endpoints.length >= 4, `expected at least 4 declared endpoints, found ${endpoints.length}`);

  const ALLOWED = ['/group-trades', '/groups', '/assets', '/accounts', '/login', '/signup', '/logout', '/session', '/trading', '/auth', '/account', '/audit', '/positions', '/blotter', '/analytics'];
  for (const path of endpoints) {
    const ok = ALLOWED.some((prefix) => path.startsWith(prefix));
    assert(ok, `the api client calls an unexpected path "/api${path}" — only the auth + planning read/preview/confirm surface is allowed`);
  }
  // The one write beyond auth that changes tenant state is group creation; there
  // is still no place/send/order-create path in the allowed set.
  for (const path of endpoints) {
    assert(!/\/place|\/orders\/create|\/execute|\/send/.test(path),
      `the api client declares a send-shaped path "/api${path}" — forbidden in rung 0`);
  }

  // The confirm body carries only the preview token, never an instruction to
  // place — the client authorises a send it never performs. The server decides
  // (dry-run or real) behind that token. Assert the confirm body shape.
  assert(/previewToken/.test(api), 'confirmTrade must send the preview token and nothing that looks like a place instruction');

  // The comment stripper must work, or a commented-out placeOrder would pass.
  assert(!/placeOrder/i.test(stripComments('// placeOrder(x)')), 'the comment stripper does not remove line comments');
  assert(/placeOrder/i.test(stripComments('const x = placeOrder')), 'the comment stripper removed real code');
}
