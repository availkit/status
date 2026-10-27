(() => {
  const toggle = document.getElementById('theme-toggle');
  const refreshLabel = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    toggle.setAttribute('aria-label', `Switch to ${next} mode`); toggle.title = `Switch to ${next} mode`;
  };
  if (toggle) {
    toggle.hidden = false; refreshLabel();
    toggle.addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; try { localStorage.setItem('availkit-theme', next); } catch { /* storage optional */ } refreshLabel(); });
  }
  let last;
  try { last = JSON.parse(document.getElementById('status-data').textContent).last; } catch { return; }
  const update = () => {
    const at = Date.parse(last?.at), age = Date.now() - at;
    if (!Number.isFinite(at) || age > 20 * 60_000 || age < -60_000) {
      document.getElementById('freshness').textContent = age < -60_000 ? 'Current status is unknown: the observation is ahead of this device’s clock. Check the UTC timestamp and monitor runs.' : 'Current status is unknown: there is no observation from the last 20 minutes. Refresh for a newer published observation or check the monitor runs.';
      for (const cell of document.querySelectorAll('[data-component]')) { cell.textContent = 'Unknown now'; cell.className = 'unknown'; }
    }
  };
  update(); setInterval(update, 60_000);
})();
