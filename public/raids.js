'use strict';

/* "Countdown to raids opening" card in the title area. The schedule comes from /api/site (src/raids.js). */
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('raid-card');
  if (!card) return;
  const OPEN_FOR = 3 * 24 * 3600e3; // keep showing "open now" this long after the last one opens
  let raids = [];
  let offset = 0; // server clock minus ours
  let timer = null;

  const two = (n) => String(n).padStart(2, '0');
  function countdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const hh = two(Math.floor((s % 86400) / 3600));
    const mm = two(Math.floor((s % 3600) / 60));
    const ss = two(s % 60);
    return d ? `${d}d ${hh}h ${mm}m ${ss}s` : `${hh}:${mm}:${ss}`;
  }
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const sizes = (list) => {
    const s = list.map((r) => r.size).filter(Boolean).sort((a, b) => a - b);
    return s.length > 1 ? `${s.slice(0, -1).join(', ')} & ${s[s.length - 1]}-man` : s.length ? `${s[0]}-man` : '';
  };

  function render() {
    const now = Date.now() + offset;
    const upcoming = raids.filter((r) => r.at > now);
    const last = Math.max(...raids.map((r) => r.at));
    if (!raids.length || (!upcoming.length && now - last > OPEN_FOR)) {
      card.hidden = true;
      clearInterval(timer);
      return;
    }
    card.hidden = false;
    const notes = [...new Set(raids.map((r) => r.note).filter(Boolean))];
    card.title = [...raids.map((r) => `${r.name}${r.size ? ` (${r.size}-man)` : ''}: ${when(r.at)}`), ...notes].join('\n');

    if (!upcoming.length) {
      $('raid-label').textContent = 'Raids are open';
      $('raid-count').textContent = 'Good luck!';
      $('raid-sub').textContent = `${sizes(raids)} · ${raids.map((r) => r.name).join(', ')}`;
      return;
    }
    const nextAt = Math.min(...upcoming.map((r) => r.at));
    const batch = upcoming.filter((r) => r.at === nextAt);
    const all = batch.length === raids.length;
    $('raid-label').textContent = all ? 'Raids open in' : batch.length > 1 ? 'Next raids open in' : `${batch[0].name} opens in`;
    $('raid-count').textContent = countdown(nextAt - now);
    $('raid-sub').textContent = `${batch.length > 1 || all ? sizes(batch) : `${batch[0].size}-man`} · ${when(nextAt)}`;
  }

  window.WFRaids = {
    set(list, serverNow) {
      raids = (Array.isArray(list) ? list : []).filter((r) => Number.isFinite(r.at));
      if (Number.isFinite(serverNow)) offset = serverNow - Date.now();
      clearInterval(timer);
      render();
      if (!card.hidden) timer = setInterval(() => { if (!document.hidden) render(); }, 1000);
    },
  };
})();
