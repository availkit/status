// Independent public checks. No application source, SDK, session or workspace authority.
export const REPOSITORY = 'availkit/status';
export const PERIOD_MS = 5 * 60_000;
export const STALE_MS = 20 * 60_000;
export const MAX_SAMPLES = 288;
export const MAX_STATE_BYTES = 256 * 1024;
export const COMPONENTS = Object.freeze([
  Object.freeze({ id: 'api', name: 'Integration API', url: 'https://api.availkit.com/ready', kind: 'ready', maxBytes: 4096 }),
  Object.freeze({ id: 'app', name: 'Application', url: 'https://app.availkit.com/', kind: 'app', maxBytes: 256 * 1024 }),
  Object.freeze({ id: 'docs', name: 'Developer documentation', url: 'https://availkit.dev/', kind: 'reading', maxBytes: 256 * 1024 }),
  Object.freeze({ id: 'home', name: 'Marketing website', url: 'https://availkit.com/', kind: 'reading', maxBytes: 256 * 1024 }),
]);
const CODES = new Set(['valid', 'http_status', 'redirect', 'media_type', 'content', 'network', 'timeout', 'body_limit']);
const OUTCOMES = new Set(['pass', 'fail', 'unknown']);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const ownKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const timestamp = (value) => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const boundedInteger = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
export function emptyState() { return { version: 1, monitoringStartedAt: null, samples: [] }; }
export function parseState(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error('Invalid monitor state');
  let state; try { state = JSON.parse(text); } catch { throw new Error('Invalid monitor state'); }
  if (!ownKeys(state, ['version', 'monitoringStartedAt', 'samples']) || state.version !== 1 || !Array.isArray(state.samples) || state.samples.length > MAX_SAMPLES) throw new Error('Invalid monitor state');
  if (state.monitoringStartedAt !== null && !timestamp(state.monitoringStartedAt)) throw new Error('Invalid monitor start');
  if ((state.monitoringStartedAt === null) !== (state.samples.length === 0)) throw new Error('Invalid monitor start');
  let previous = -Infinity;
  const runs = new Set();
  for (const sample of state.samples) {
    if (!ownKeys(sample, ['run', 'at', 'results']) || typeof sample.run !== 'string' || !/^[1-9][0-9]{0,19}$/.test(sample.run) || !timestamp(sample.at) || Date.parse(sample.at) < previous || runs.has(sample.run)) throw new Error('Invalid observation');
    if (!Array.isArray(sample.results) || sample.results.length !== COMPONENTS.length) throw new Error('Invalid observation');
    runs.add(sample.run); previous = Date.parse(sample.at);
    for (const [index, r] of sample.results.entries()) {
      if (!ownKeys(r, ['id', 'outcome', 'code', 'status', 'durationMs']) || r.id !== COMPONENTS[index].id || !OUTCOMES.has(r.outcome) || !CODES.has(r.code) || !(r.status === null || boundedInteger(r.status, 100, 599)) || !boundedInteger(r.durationMs, 0, 60_000)) throw new Error('Invalid probe result');
      if ((r.outcome === 'pass') !== (r.code === 'valid') || (r.code === 'valid' && r.status !== 200)) throw new Error('Invalid probe result');
      if (['network', 'timeout', 'body_limit'].includes(r.code) && r.outcome !== 'unknown') throw new Error('Invalid probe result');
      if (['http_status', 'redirect', 'media_type', 'content'].includes(r.code) && r.outcome !== 'fail') throw new Error('Invalid probe result');
    }
  }
  if (state.samples.length && Date.parse(state.monitoringStartedAt) > Date.parse(state.samples[0].at)) throw new Error('Invalid monitor start');
  return state;
}
export function encodeState(state) { const text = JSON.stringify(state) + '\n'; parseState(text); return text; }

function checkContent(component, media, text) {
  if (component.kind === 'ready') {
    if (!/^application\/json(?:\s*;|$)/i.test(media)) return 'media_type';
    let body; try { body = JSON.parse(text); } catch { return 'content'; }
    return body && body.status === 'ready' && body.backend === 'postgresql' && boundedInteger(body.schema_version, 1, 1000) ? 'valid' : 'content';
  }
  if (!/^text\/html(?:\s*;|$)/i.test(media)) return 'media_type';
  if (!/<html(?:\s|>)/i.test(text) || !/<title>[^<]*AvailKit[^<]*<\/title>/i.test(text)) return 'content';
  if (component.kind === 'app') return /<div\s+id=["']root["']/.test(text) && /<script\b/.test(text) ? 'valid' : 'content';
  return /<main(?:\s|>)/.test(text) && /https:\/\/availkit\.(?:dev|com)/.test(text) ? 'valid' : 'content';
}
export async function probe(component, { fetchImpl = globalThis.fetch, timeoutMs = 8000, clock = Date.now } = {}) {
  // Callers cannot expand the endpoint allowlist by supplying a new object or URL.
  if (!COMPONENTS.includes(component) || !boundedInteger(timeoutMs, 1, 8000)) throw new Error('Invalid fixed probe');
  const start = clock();
  const controller = new AbortController();
  let timer, reader, status = null;
  const result = (outcome, code) => ({ id: component.id, outcome, code, status, durationMs: Math.max(0, Math.min(60_000, Math.round(clock() - start))) });
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs); });
  const work = async () => {
    const response = await fetchImpl(component.url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { Accept: component.kind === 'ready' ? 'application/json' : 'text/html', 'User-Agent': 'AvailKit-Status/1.0 (+https://availkit.github.io/status/)' },
    });
    status = response.status;
    if (response.redirected || status >= 300 && status < 400) return result('fail', 'redirect');
    if (status !== 200) return result('fail', 'http_status');
    // Do not persist or report response headers, bodies, redirect locations or thrown messages.
    if (!response.body) return result('fail', 'content');
    reader = response.body.getReader();
    let size = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > component.maxBytes) { controller.abort(); return result('unknown', 'body_limit'); }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    const code = checkContent(component, response.headers.get('content-type') ?? '', text);
    return result(code === 'valid' ? 'pass' : 'fail', code);
  };
  try { return await Promise.race([work(), deadline]); }
  catch { return result('unknown', controller.signal.aborted ? 'timeout' : 'network'); }
  finally {
    clearTimeout(timer); controller.abort();
    // Some injected/network transports ignore cancellation: never await an unbounded cancel.
    try { reader?.cancel().catch(() => {}); } catch { /* no diagnostics from remote data */ }
  }
}
export async function observe(run, { fetchImpl, now = new Date(), timeoutMs = 8000 } = {}) {
  if (!/^[1-9][0-9]{0,19}$/.test(run) || !timestamp(now.toISOString())) throw new Error('Invalid run');
  const results = await Promise.all(COMPONENTS.map(component => probe(component, { fetchImpl, timeoutMs })));
  return { run, at: now.toISOString(), results };
}
export function appendObservation(state, sample) {
  parseState(JSON.stringify(state));
  if (state.samples.some(s => s.run === sample.run)) throw new Error('Observation already retained');
  const candidate = { version: 1, monitoringStartedAt: state.monitoringStartedAt ?? sample.at, samples: [...state.samples, sample].slice(-MAX_SAMPLES) };
  return parseState(JSON.stringify(candidate));
}
export function freshness(state, now = Date.now()) {
  const last = state.samples.at(-1);
  if (!last) return 'unknown';
  const age = now - Date.parse(last.at);
  return age < -60_000 ? 'clock_unknown' : age > STALE_MS ? 'stale' : 'recent';
}
export function coverage(state, now = Date.now()) {
  if (!state.samples.length || now < Date.parse(state.monitoringStartedAt)) return { expected: 0, observed: 0, missing: 0, samples: 0, passedChecks: 0, failedChecks: 0, unknownChecks: 0 };
  const first = Math.max(Math.floor(Date.parse(state.monitoringStartedAt) / PERIOD_MS), Math.floor(now / PERIOD_MS) - MAX_SAMPLES + 1);
  const last = Math.floor(now / PERIOD_MS) - 1;
  const retained = state.samples.filter(s => Date.parse(s.at) <= now && Math.floor(Date.parse(s.at) / PERIOD_MS) >= first);
  const buckets = new Set(retained.map(s => Math.floor(Date.parse(s.at) / PERIOD_MS)).filter(bucket => bucket <= last));
  const results = retained.flatMap(s => s.results);
  const expected = Math.max(0, last - first + 1);
  return { expected, observed: buckets.size, missing: expected - buckets.size, samples: retained.length,
    passedChecks: results.filter(r => r.outcome === 'pass').length, failedChecks: results.filter(r => r.outcome === 'fail').length, unknownChecks: results.filter(r => r.outcome === 'unknown').length };
}
export function alertWanted(state, id) {
  const last = state.samples.at(-1), previous = state.samples.at(-2);
  if (!last) return null;
  const current = last.results.find(r => r.id === id);
  if (!current) return null;
  if (current.outcome === 'pass') return 'closed';
  if (!previous || Date.parse(last.at) - Date.parse(previous.at) > STALE_MS) return null;
  return previous.results.find(r => r.id === id)?.outcome !== 'pass' ? 'open' : null;
}
