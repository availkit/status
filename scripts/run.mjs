import { readFile, mkdir, writeFile, copyFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { REPOSITORY, COMPONENTS, observe, appendObservation, alertWanted, encodeState } from './monitor.mjs';
import { githubClient, loadState, saveState, reconcileIssue, reserveIssueCreation } from './github.mjs';
import { render, publicView } from './render.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function prepareSite(state) {
  const output = resolve(root, '_site');
  await mkdir(resolve(output, 'data'), { recursive: true });
  await mkdir(resolve(output, 'fonts'), { recursive: true });
  await mkdir(resolve(output, 'licenses'), { recursive: true });
  for (const path of ['status.css', 'status.js', 'theme.js', 'fonts/manrope-variable.ttf', 'licenses/Manrope-OFL.txt']) {
    await copyFile(resolve(root, 'site', path), resolve(output, path));
  }
  const now = Date.now();
  const template = await readFile(resolve(root, 'site/index.template.html'), 'utf8');
  await writeFile(resolve(output, 'index.html'), render(template, state, now));
  await writeFile(resolve(output, 'data/status.json'), JSON.stringify(publicView(state, now)) + '\n');
  // No-JS historical samples are in the public repository; this JSON is bounded as well.
  await writeFile(resolve(output, 'data/observations.json'), encodeState(state));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'site_ready=true\n');
}
async function main() {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[1-9][0-9]{0,19}$/.test(process.env.GITHUB_RUN_ID ?? '')) throw new Error('Invalid monitor context');
  const api = githubClient(process.env.GITHUB_TOKEN);
  const mode = process.env.MONITOR_MODE || 'observe';
  if (!['observe', 'drill-failure', 'drill-recovery'].includes(mode)) throw new Error('Invalid mode');
  if (mode !== 'observe') {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Drill requires manual dispatch');
    await reconcileIssue(api, { id: 'drill', wanted: mode === 'drill-failure' ? 'open' : 'closed', at: new Date().toISOString(), beforeCreate: id => reserveIssueCreation(api, id, process.env.GITHUB_RUN_ID) });
    console.log('Controlled alert drill completed. No public endpoint was probed and no observation history or status page was changed.');
    return;
  }
  const loaded = await loadState(api);
  let state = loaded.state;
  if (!state.samples.some(sample => sample.run === process.env.GITHUB_RUN_ID)) {
    // Exactly one four-endpoint sample. No retry, fallback target or follow-redirect path.
    const sample = await observe(process.env.GITHUB_RUN_ID);
    state = appendObservation(state, sample);
    await saveState(api, loaded.sha, state);
  }
  // Render retained actual observations even when a later alert request fails.
  await prepareSite(state);
  const last = state.samples.at(-1);
  const alerts = [];
  // Serialize the tiny shared creation ledger; each independent failure is joined.
  for (const component of COMPONENTS) {
    try { await reconcileIssue(api, { id: component.id, wanted: alertWanted(state, component.id), at: last.at, beforeCreate: id => reserveIssueCreation(api, id, process.env.GITHUB_RUN_ID) }); alerts.push(true); }
    catch { alerts.push(false); }
  }
  if (alerts.some(success => !success)) throw new Error('Alert synchronization unconfirmed');
  console.log('External observation retained; status prepared; alert states reconciled.');
}
main().catch(() => {
  console.error('Monitor could not confirm completion. Inspect the workflow and last published UTC observation; do not infer current availability or alert delivery. Remote bodies, headers and credentials are omitted.');
  process.exitCode = 1;
});
