import { COMPONENTS, coverage, freshness, parseState } from './monitor.mjs';
export function publicView(state, now = Date.now()) {
  // Revalidate and project; no arbitrary persisted fields become public HTML or JSON.
  parseState(JSON.stringify(state));
  const last = state.samples.at(-1) ?? null;
  return { version: 1, generatedAt: new Date(now).toISOString(), monitoringStartedAt: state.monitoringStartedAt, last, unknownAfter: last ? new Date(Date.parse(last.at) + 20 * 60_000).toISOString() : null, coverage: coverage(state, now), freshnessAtGeneration: freshness(state, now) };
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const titles = { pass: 'Passed this sample', fail: 'Check failed', unknown: 'Unconfirmed' };
const explanations = { valid: 'Expected public content received', http_status: 'Unexpected HTTP status', redirect: 'Redirect refused', media_type: 'Unexpected content type', content: 'Expected content not confirmed', network: 'Network check unconfirmed', timeout: 'Whole-response deadline exceeded', body_limit: 'Response exceeded the check limit' };
export function render(template, state, now = Date.now()) {
  const view = publicView(state, now);
  const at = view.last?.at;
  const expiry = at ? new Date(Date.parse(at) + 20 * 60_000).toISOString() : null;
  const observation = at ? `<p id="observation-time">Last observation: <time datetime="${at}">${at.replace('T', ' ').replace('.000Z', ' UTC')}</time>.</p><p id="freshness" class="notice warning" role="status">This is the last observation, not a continuous availability claim. After <time datetime="${expiry}">${expiry.replace('T', ' ').replace('.000Z', ' UTC')}</time> (20 minutes), or if your clock is uncertain, current status is <strong>unknown</strong>. Refresh this page for a newer published observation.</p>` : '<p id="observation-time">No observations have been recorded.</p><p id="freshness" class="notice warning" role="status">Current status is unknown. Monitoring history starts with the first real observation.</p>';
  const rows = COMPONENTS.map(c => {
    const r = view.last?.results.find(r => r.id === c.id);
    return `<tr><th scope="row"><a href="${c.url}">${c.name}</a><span class="endpoint">${new URL(c.url).host}${new URL(c.url).pathname}</span></th><td data-component="${c.id}" class="${r?.outcome ?? 'unknown'}">${r ? titles[r.outcome] : 'Unknown'}</td><td>${r ? escape(explanations[r.code]) + (r.status === null ? '' : ' · HTTP ' + r.status) : 'No observation'}</td></tr>`;
  }).join('');
  const c = view.coverage;
  const counts = at ? `<p>Since <time datetime="${view.monitoringStartedAt}">${view.monitoringStartedAt.replace('T', ' ').replace('.000Z', ' UTC')}</time>, the retained window contains ${c.samples} real samples: ${c.passedChecks} passing checks, ${c.failedChecks} failed checks and ${c.unknownChecks} unconfirmed checks. Sample success is ${c.passedChecks} of ${c.samples * 4} endpoint checks; this is not an uptime percentage.</p><p>Completed five-minute windows with a retained observation: ${c.observed} of ${c.expected}. Completed windows without a retained observation: <strong>${c.missing}</strong>. These gaps have unknown availability. At most 288 actual samples are retained; this view covers at most the latest 24 hours and begins no earlier than the first observation.</p>` : '<p>There is no measured history yet. We do not infer earlier availability or fill missed checks with successful results.</p>';
  const values = { OBSERVATION: observation, COMPONENTS: rows, COVERAGE: counts, DATA: JSON.stringify(view).replaceAll('<', '\\u003c') };
  for (const [key, value] of Object.entries(values)) {
    const tag = `<!--${key}-->`;
    if (template.split(tag).length !== 2) throw new Error('Invalid status template');
    template = template.replace(tag, () => value);
  }
  return template;
}
