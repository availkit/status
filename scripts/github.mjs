import { REPOSITORY, MAX_STATE_BYTES, parseState, encodeState } from './monitor.mjs';
const API = 'https://api.github.com';
const ROOT = `/repos/${REPOSITORY}`;
const DEADLINE = 8000;
const MAX_API_BYTES = 1024 * 1024;
// Finite diagnostics only. HTTP response bodies/headers and exception messages are never logged.
export class GitHubFailure extends Error {
  constructor(kind) { super('GitHub monitor operation unconfirmed'); this.kind = kind; }
}
export function githubClient(token, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new GitHubFailure('configuration');
  return async function request(method, path, body) {
    if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method) || !path.startsWith(ROOT + '/') || path.includes('..') || path.includes('#')) throw new GitHubFailure('configuration');
    const controller = new AbortController(); let timer, reader;
    const work = async () => {
      const response = await fetchImpl(API + path, {
        method, redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'AvailKit-Status/1.0' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || response.redirected) throw new GitHubFailure(response.status === 404 ? 'missing' : response.status === 409 ? 'conflict' : 'http');
      if (!response.body) throw new GitHubFailure('protocol');
      reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MAX_API_BYTES) throw new GitHubFailure('protocol'); chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GitHubFailure('protocol'); }
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GitHubFailure('unknown')); }, DEADLINE); })]);
    } catch (error) { throw error instanceof GitHubFailure ? error : new GitHubFailure('unknown'); }
    finally { clearTimeout(timer); controller.abort(); try { reader?.cancel().catch(() => {}); } catch { /* bounded cleanup */ } }
  };
}
export async function loadState(api) {
  const file = await api('GET', `${ROOT}/contents/data/state.json?ref=main`);
  if (file?.encoding !== 'base64' || !/^[0-9a-f]{40}$/.test(file.sha) || typeof file.content !== 'string' || file.content.length > MAX_STATE_BYTES * 2) throw new GitHubFailure('protocol');
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  const state = parseState(text);
  return { state, sha: file.sha, text };
}
export async function saveState(api, oldSha, state) {
  const text = encodeState(state);
  try {
    await api('PUT', `${ROOT}/contents/data/state.json`, {
      message: `Record external observation ${state.samples.at(-1).run}`, branch: 'main', sha: oldSha,
      content: Buffer.from(text).toString('base64'),
    });
  } catch (error) {
    // A lost write acknowledgement is not permission to repeat a mutation.
    // Reconcile by exact document bytes, otherwise stop; the next job reloads main.
    const found = await loadState(api);
    if (found.text !== text) throw new GitHubFailure(error?.kind === 'conflict' ? 'conflict' : 'unknown');
  }
}
const IDS = new Set(['api', 'app', 'docs', 'home', 'drill']);
const marker = id => `<!-- availkit-monitor:v1:${id} -->`;
const label = id => `monitor-${id}`;
function validIssue(issue, id) {
  return issue && !issue.pull_request && Number.isSafeInteger(issue.number) && issue.number > 0 && ['open', 'closed'].includes(issue.state) &&
    typeof issue.body === 'string' && issue.body.includes(marker(id)) && Array.isArray(issue.labels) && issue.labels.some(l => l?.name === label(id));
}
async function findIssue(api, id) {
  const issues = await api('GET', `${ROOT}/issues?state=all&labels=${label(id)}&per_page=100`);
  if (!Array.isArray(issues) || issues.length >= 100) throw new GitHubFailure('manual_attention');
  const matching = issues.filter(i => validIssue(i, id));
  if (matching.length > 1) throw new GitHubFailure('manual_attention');
  return matching[0] ?? null;
}
export async function reconcileIssue(api, { id, wanted, at, beforeCreate }) {
  if (!IDS.has(id) || !['open', 'closed', null].includes(wanted) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)) throw new GitHubFailure('configuration');
  let issue = await findIssue(api, id);
  if (wanted === null || !issue && wanted === 'closed' || issue?.state === wanted) return { action: 'none', number: issue?.number ?? null };
  if (issue) {
    try { await api('PATCH', `${ROOT}/issues/${issue.number}`, { state: wanted, ...(wanted === 'closed' ? { state_reason: 'completed' } : {}) }); }
    catch {
      issue = await findIssue(api, id);
      if (issue?.state !== wanted) throw new GitHubFailure('unknown');
    }
    return { action: wanted === 'open' ? 'reopened' : 'closed', number: issue.number };
  }
  // Reservation must be durable before sending. A later negative search cannot prove
  // that an earlier unknown POST did not commit; never automatically create again.
  if (typeof beforeCreate !== 'function') throw new GitHubFailure('configuration');
  await beforeCreate(id);
  const drill = id === 'drill';
  const name = { api: 'Integration API', app: 'Application', docs: 'Developer documentation', home: 'Marketing website', drill: 'Alert delivery drill' }[id];
  const title = drill ? '[DRILL] Monitor alert delivery' : `External check concern: ${name}`;
  const body = `${marker(id)}\n\n${drill ? '**CONTROLLED DRILL. No production failure is asserted.**' : 'Two consecutive external samples could not confirm this public endpoint. This does not establish the scope of a service outage.'}\n\nObserved at ${at} (UTC).\n\n[Last observations](https://availkit.github.io/status/) · [Monitor runs](https://github.com/availkit/status/actions/workflows/observe.yml)\n\nOperators: record verified impact, detection, updates and follow-ups in comments. A later passing check closes this thread automatically; closure means this public check recovered, not that all customer impact is resolved. The thread is reused on a later concern.\n`;
  try {
    const created = await api('POST', `${ROOT}/issues`, { title, body, labels: [label(id)] });
    if (!validIssue(created, id) || created.state !== 'open') throw new GitHubFailure('protocol');
    issue = created;
  } catch {
    // Includes lost creation responses. Only read reconciliation is permitted.
    issue = await findIssue(api, id);
    if (!issue || issue.state !== 'open') throw new GitHubFailure('unknown');
  }
  return { action: 'created', number: issue.number };
}

const LEDGER_PATH = `${ROOT}/contents/data/alerts.json`;
function parseLedger(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'attempts,version' || !value.attempts || typeof value.attempts !== 'object' || Array.isArray(value.attempts) || Object.keys(value.attempts).sort().join(',') !== [...IDS].sort().join(',')) throw new GitHubFailure('protocol');
  for (const attempt of Object.values(value.attempts)) if (attempt !== null && !(typeof attempt === 'string' && /^[1-9][0-9]{0,19}$/.test(attempt))) throw new GitHubFailure('protocol');
  return value;
}
async function loadLedger(api) {
  const file = await api('GET', LEDGER_PATH + '?ref=main');
  if (file?.encoding !== 'base64' || !/^[0-9a-f]{40}$/.test(file.sha) || typeof file.content !== 'string' || file.content.length > 4096) throw new GitHubFailure('protocol');
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  let value; try { value = JSON.parse(text); } catch { throw new GitHubFailure('protocol'); }
  return { sha: file.sha, value: parseLedger(value), text };
}
export async function reserveIssueCreation(api, id, run) {
  if (!IDS.has(id) || typeof run !== 'string' || !/^[1-9][0-9]{0,19}$/.test(run)) throw new GitHubFailure('configuration');
  const ledger = await loadLedger(api);
  if (ledger.value.attempts[id] !== null) throw new GitHubFailure('manual_attention');
  ledger.value.attempts[id] = run;
  const text = JSON.stringify(ledger.value) + '\n';
  try {
    await api('PUT', LEDGER_PATH, { message: `Reserve canonical ${id} alert creation`, branch: 'main', sha: ledger.sha, content: Buffer.from(text).toString('base64') });
  } catch {
    const found = await loadLedger(api);
    if (found.text !== text) throw new GitHubFailure('unknown');
  }
}
