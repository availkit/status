import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { COMPONENTS, MAX_SAMPLES, emptyState, parseState, encodeState, probe, observe, appendObservation, freshness, coverage, alertWanted } from '../scripts/monitor.mjs';
import { githubClient, GitHubFailure, loadState, saveState, reconcileIssue, reserveIssueCreation } from '../scripts/github.mjs';
import { render } from '../scripts/render.mjs';
const start = '2026-10-27T12:02:00.000Z';
function sample(run = '1', at = start, outcomes = ['pass', 'pass', 'pass', 'pass']) {
  return { run, at, results: COMPONENTS.map((c, i) => ({ id: c.id, outcome: outcomes[i], code: outcomes[i] === 'pass' ? 'valid' : outcomes[i] === 'fail' ? 'http_status' : 'network', status: outcomes[i] === 'unknown' ? null : outcomes[i] === 'pass' ? 200 : 503, durationMs: 12 })) };
}
function state(...samples) { return { version: 1, monitoringStartedAt: samples[0]?.at ?? null, samples }; }
function okResponse(component) {
  return component.kind === 'ready' ? new Response('{"status":"ready","backend":"postgresql","schema_version":21}', { headers: { 'content-type': 'application/json' } }) : new Response('<!doctype html><html><head><title>AvailKit developers</title></head><body><div id="root"></div><main><a href="https://availkit.dev/">Docs</a></main><script src="./app.js"></script></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
const issue = (id = 'api', open = true, number = 7) => ({ number, state: open ? 'open' : 'closed', body: `<!-- availkit-monitor:v1:${id} -->\nKnown facts`, labels: [{ name: `monitor-${id}` }] });

test('the four public probes send once with exact endpoints and no authority or redirects', async () => {
  const calls = [];
  const s = await observe('123', { now: new Date(start), fetchImpl: async (url, options) => {
    calls.push({ url, options }); return okResponse(COMPONENTS.find(c => c.url === url));
  } });
  assert.equal(calls.length, 4); assert.deepEqual(calls.map(c => c.url).sort(), COMPONENTS.map(c => c.url).sort());
  for (const c of calls) {
    assert.equal(c.options.method, 'GET'); assert.equal(c.options.credentials, 'omit'); assert.equal(c.options.redirect, 'manual');
    assert.deepEqual(Object.keys(c.options.headers).sort(), ['Accept', 'User-Agent']); assert.match(c.options.headers['User-Agent'], /^AvailKit-Status/);
  }
  assert(s.results.every(r => r.outcome === 'pass')); parseState(JSON.stringify(state(s)));
  await assert.rejects(probe({ ...COMPONENTS[0], url: 'https://unapproved.invalid/' }));
});
test('redirect, status, MIME and actual schema/content failures are not successful checks', async () => {
  let calls = 0;
  const cases = [
    [new Response('private', { status: 302, headers: { location: 'https://unapproved.invalid/?secret' } }), 'redirect'],
    [new Response('private', { status: 503 }), 'http_status'],
    [new Response('{"status":"ready","backend":"postgresql","schema_version":21}', { headers: { 'content-type': 'text/plain' } }), 'media_type'],
    [new Response('{"status":"live","backend":"postgresql","schema_version":21}', { headers: { 'content-type': 'application/json' } }), 'content'],
  ];
  for (const [response, code] of cases) { const r = await probe(COMPONENTS[0], { fetchImpl: async () => { calls++; return response; } }); assert.equal(r.outcome, 'fail'); assert.equal(r.code, code); }
  assert.equal(calls, 4);
  const shell = await probe(COMPONENTS[2], { fetchImpl: async () => new Response('<html><title>AvailKit</title><div id="root"></div>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(shell.code, 'content');
});
test('timeout bounds whole-body consumption; untrusted exceptions and content are redacted', async () => {
  const secret = 'DO_NOT_PUBLISH_SECRET_4321'; let canceled = false;
  const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(secret)); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'application/json', 'set-cookie': secret, 'x-address': secret } });
  const timed = await probe(COMPONENTS[0], { fetchImpl: async () => stalled, timeoutMs: 5 });
  assert.equal(timed.outcome, 'unknown'); assert.equal(timed.code, 'timeout'); assert.equal(canceled, true);
  const failed = await probe(COMPONENTS[0], { fetchImpl: async () => { throw new Error(secret); } });
  assert.equal(failed.code, 'network'); assert(!JSON.stringify([timed, failed]).includes(secret));
});
test('body byte limits stop unconfirmed checks without publishing contents', async () => {
  const result = await probe(COMPONENTS[0], { fetchImpl: async () => new Response('private'.repeat(700), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.code, 'body_limit'); assert.equal(result.outcome, 'unknown'); assert(!JSON.stringify(result).includes('private'));
});
test('state accepts only public finite projections and rejects malformed or secret fields', () => {
  assert.deepEqual(parseState(encodeState(emptyState())), emptyState());
  const s = state(sample()); s.samples[0].results[0].headers = { authorization: 'secret' };
  assert.throws(() => parseState(JSON.stringify(s)));
  assert.throws(() => parseState('x'.repeat(256 * 1024 + 1)));
  assert.throws(() => parseState(JSON.stringify(state(sample('1'), sample('1', '2026-10-27T12:07:00.000Z')))));
  const bad = sample(); bad.results[0].outcome = 'fail'; assert.throws(() => parseState(JSON.stringify(state(bad))));
});
test('retention keeps at most 288 real observations and never seeds earlier success', () => {
  let s = emptyState();
  for (let i = 0; i < MAX_SAMPLES + 4; i++) s = appendObservation(s, sample(String(i + 1), new Date(Date.parse(start) + i * 300_000).toISOString()));
  assert.equal(s.samples.length, 288); assert.equal(s.samples[0].run, '5'); assert.equal(s.monitoringStartedAt, start);
  assert.throws(() => appendObservation(s, s.samples.at(-1)));
});
test('sample outcomes and missing completed windows are counted separately from the first observation', () => {
  const s = state(sample(), sample('2', '2026-10-27T12:12:00.000Z', ['fail', 'unknown', 'pass', 'pass']));
  const c = coverage(s, Date.parse('2026-10-27T12:16:00.000Z'));
  assert.deepEqual(c, { expected: 3, observed: 2, missing: 1, samples: 2, passedChecks: 6, failedChecks: 1, unknownChecks: 1 });
  assert.equal(coverage(s, Date.parse(start)).expected, 0);
  assert.equal(coverage(emptyState()).expected, 0); assert(!('uptime' in c));
});
test('staleness, missing observations and a future device clock cannot imply current availability', () => {
  assert.equal(freshness(emptyState()), 'unknown');
  assert.equal(freshness(state(sample()), Date.parse(start) + 1_200_001), 'stale');
  assert.equal(freshness(state(sample()), Date.parse(start) - 60_001), 'clock_unknown');
  assert.equal(freshness(state(sample()), Date.parse(start) + 120_000), 'recent');
});
test('alerts need two contiguous failed/unconfirmed samples and only a pass requests recovery', () => {
  const bad = sample('1', start, ['unknown', 'pass', 'pass', 'pass']);
  const next = sample('2', '2026-10-27T12:07:00.000Z', ['fail', 'pass', 'pass', 'pass']);
  assert.equal(alertWanted(state(bad), 'api'), null);
  assert.equal(alertWanted(state(bad, next), 'api'), 'open');
  assert.equal(alertWanted(state(bad, sample('2', '2026-10-27T12:27:00.000Z', ['fail', 'pass', 'pass', 'pass'])), 'api'), null);
  assert.equal(alertWanted(state(bad, sample('2', '2026-10-27T12:07:00.000Z')), 'api'), 'closed');
});
test('lost issue creation is reconciled before any later attempt, with no duplicate post', async () => {
  const calls = []; let existing = null;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return existing ? [existing] : [];
    assert.equal(method, 'POST'); existing = issue(); throw new Error('lost creation response with private data');
  };
  assert.equal((await reconcileIssue(api, { id: 'api', wanted: 'open', at: start, beforeCreate: async () => {} })).number, 7);
  assert.equal((await reconcileIssue(api, { id: 'api', wanted: 'open', at: start, beforeCreate: async () => {} })).action, 'none');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert(calls[1].body.body.includes('Two consecutive')); assert(!calls[1].body.body.includes('@'));
});
test('lost close is read-reconciled and a later concern reopens the same thread only once', async () => {
  let current = issue(); const writes = [];
  const api = async (method, path, body) => {
    if (method === 'GET') return [current];
    writes.push({ method, path, body }); current = { ...current, state: body.state }; throw new Error('lost acknowledgement');
  };
  assert.equal((await reconcileIssue(api, { id: 'api', wanted: 'closed', at: start })).action, 'closed');
  assert.equal((await reconcileIssue(api, { id: 'api', wanted: 'closed', at: start })).action, 'none');
  assert.equal((await reconcileIssue(api, { id: 'api', wanted: 'open', at: start, beforeCreate: async () => {} })).action, 'reopened');
  assert.equal(writes.length, 2); assert(writes.every(w => w.method === 'PATCH' && w.path.endsWith('/7')));
  assert(writes.every(w => !('body' in w.body))); // Preserve operator comments/body.
});
test('unknown creates and duplicate canonical markers stop rather than post again', async () => {
  let posts = 0;
  await assert.rejects(reconcileIssue(async method => { if (method === 'GET') return []; posts++; throw new Error('lost'); }, { id: 'api', wanted: 'open', at: start, beforeCreate: async () => {} }), GitHubFailure);
  assert.equal(posts, 1);
  let mutations = 0;
  await assert.rejects(reconcileIssue(async method => { if (method !== 'GET') mutations++; return [issue(), issue('api', false, 8)]; }, { id: 'api', wanted: 'open', at: start, beforeCreate: async () => {} }), GitHubFailure);
  assert.equal(mutations, 0);
});
test('controlled drills are distinctly marked and cannot use an arbitrary component', async () => {
  let body;
  const r = await reconcileIssue(async (method, path, value) => { if (method === 'GET') return []; body = value; return issue('drill'); }, { id: 'drill', wanted: 'open', at: start, beforeCreate: async () => {} });
  assert.equal(r.number, 7); assert.match(body.title, /^\[DRILL\]/); assert.match(body.body, /No production failure/); assert.deepEqual(body.labels, ['monitor-drill']);
  await assert.rejects(reconcileIssue(async () => assert.fail('must not call API'), { id: 'arbitrary @user', wanted: 'open', at: start, beforeCreate: async () => {} }));
});
test('lost state commit is accepted only after exact-byte read reconciliation; no repeat PUT', async () => {
  const proposed = state(sample()); let puts = 0;
  const file = value => ({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(encodeState(value)).toString('base64') });
  const api = async method => { if (method === 'PUT') { puts++; throw new Error('lost'); } return file(proposed); };
  await saveState(api, 'b'.repeat(40), proposed); assert.equal(puts, 1);
  await assert.rejects(saveState(async method => { if (method === 'PUT') { puts++; throw new GitHubFailure('conflict'); } return file(emptyState()); }, 'b'.repeat(40), proposed));
  assert.equal(puts, 2); assert.equal((await loadState(api)).state.samples.length, 1);
});
test('GitHub transport fixes the API host, forbids redirect following and scrubs errors', async () => {
  let seen;
  const api = githubClient('private-token', { fetchImpl: async (url, options) => { seen = { url, options }; throw new Error('private-token remote-body private-IP'); } });
  await assert.rejects(api('GET', '/repos/availkit/status/issues?state=all'), error => !error.message.includes('private-token') && !error.message.includes('remote-body'));
  assert.equal(seen.url, 'https://api.github.com/repos/availkit/status/issues?state=all'); assert.equal(seen.options.redirect, 'manual');
  assert.equal(seen.options.headers.Authorization, 'Bearer private-token');
  await assert.rejects(api('GET', 'https://attacker.invalid/')); await assert.rejects(api('GET', '/repos/availkit/other/issues'));
});
test('static HTML has real UTC last-observation/expiry and no invented initial history', async () => {
  const template = await readFile(new URL('../site/index.template.html', import.meta.url), 'utf8');
  const html = render(template, state(sample()), Date.parse('2026-10-27T12:04:00.000Z'));
  assert.match(html, /Last observation:/); assert.match(html, /2026-10-27T12:02:00.000Z/); assert.match(html, /2026-10-27T12:22:00.000Z/);
  assert.match(html, /4 of 4 endpoint checks/); assert.match(html, /not an uptime percentage/); assert(!html.includes('<!--COMPONENTS-->'));
  const initial = render(template, emptyState()); assert.match(initial, /No observations have been recorded/); assert(!initial.includes('Passed this sample'));
});
test('browser enhancement marks stale and future observations unknown without making network requests', async () => {
  const source = await readFile(new URL('../site/status.js', import.meta.url), 'utf8');
  for (const now of [Date.parse(start) + 1_200_001, Date.parse(start) - 60_001]) {
    const notice = {}, cells = [{}, {}, {}, {}];
    const toggle = { setAttribute() {}, addEventListener() {} };
    const document = { documentElement: { dataset: { theme: 'dark' } }, getElementById(id) { return id === 'theme-toggle' ? toggle : id === 'status-data' ? { textContent: JSON.stringify({ last: sample() }) } : notice; }, querySelectorAll() { return cells; } };
    runInNewContext(source, { document, Date: { now: () => now, parse: Date.parse }, setInterval() {}, localStorage: { setItem() {} } });
    assert.match(notice.textContent, /unknown/); assert(cells.every(c => c.textContent === 'Unknown now'));
  }
});

test('durable creation reservation precedes POST and blocks a later unresolved creation', async () => {
  let ledger = { version: 1, attempts: { api: null, app: null, docs: null, home: null, drill: null } };
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path });
    if (path.includes('/contents/data/alerts.json')) {
      if (method === 'PUT') { ledger = JSON.parse(Buffer.from(body.content, 'base64').toString()); return {}; }
      return { encoding: 'base64', sha: 'c'.repeat(40), content: Buffer.from(JSON.stringify(ledger)).toString('base64') };
    }
    if (method === 'GET') return [];
    throw new Error('unknown POST acknowledgement');
  };
  await assert.rejects(reconcileIssue(api, { id: 'api', wanted: 'open', at: start, beforeCreate: id => reserveIssueCreation(api, id, '101') }));
  await assert.rejects(reconcileIssue(api, { id: 'api', wanted: 'open', at: start, beforeCreate: id => reserveIssueCreation(api, id, '102') }));
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  assert(calls.findIndex(c => c.method === 'PUT') < calls.findIndex(c => c.method === 'POST'));
  assert.equal(ledger.attempts.api, '101');
});
