'use strict';

/* Admin "Visitors" panel: cookieless page-view stats from /api/admin/visits. */
(() => {
  const { h, ago, fullDate, api } = window.WF;
  const $ = (id) => document.getElementById(id);
  const HOUR = 3600e3;
  let timer = null;
  let data = null;

  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(undefined, { type: 'region' }); } catch { /* old browser */ }
  const countryName = (c) => {
    if (!c) return '—';
    if (c === 'T1') return 'Tor';
    try { return regionNames?.of(c) || c; } catch { return c; }
  };

  function fmtDur(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 1) return '—';
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const deviceText = (v) => [v.device, v.os, v.browser].filter((x) => x && x !== 'Other').join(' · ') || 'Unknown';
  const TAB_NAMES = { activity: 'Activity', stats: 'Stats' };
  const tabsText = (tabs) => (tabs?.length ? tabs.map((t) => TAB_NAMES[t] || t).join(', ') : '');

  // Don't re-render while a name is being typed.
  const editing = () => document.activeElement && $('visits-panel').contains(document.activeElement)
    && document.activeElement.classList.contains('vis-label');

  async function load() {
    if (editing()) return;
    try {
      const q = new URLSearchParams({ range: $('vis-range').value, mine: $('vis-mine').checked ? '1' : '0', tz: String(new Date().getTimezoneOffset()) });
      data = await api(`/api/admin/visits?${q}`);
      render();
    } catch (err) {
      if (err.status !== 401) $('vis-msg').textContent = err.message;
    }
  }

  function render() {
    const d = data;
    const t = d.totals;
    $('vis-msg').textContent = '';
    const tile = (label, value, sub, title) => h('div.status-item', { title: title || null },
      h('span.label', label), h('span.value.vis-big', value), sub ? h('span.vis-sub', sub) : null);
    const pct = (n) => (t.views ? `${Math.round((n / t.views) * 100)}% of visits` : '');
    $('vis-tiles').replaceChildren(
      tile('Online now', String(t.online), t.online ? 'page open in the last 2–3 min' : 'nobody right now'),
      tile('Page views', String(t.views), d.hourly ? 'last 24 hours' : `last ${d.range.replace('d', ' days')}`),
      tile('Visitors', String(t.visitors), 'unique IP addresses'),
      tile('Returning', String(t.returning), t.visitors ? `${Math.round((t.returning / t.visitors) * 100)}% came back another day` : '',
        'Visited on 2+ different days, or also before this range'),
      tile('Time on page', fmtDur(t.medianTime), `median · ${fmtDur(t.totalTime)} in total`, 'Counted only while the tab is visible'),
      tile('Opened tabs', `${t.openedActivity} / ${t.openedStats}`, `Activity / Stats · ${pct(Math.max(t.openedActivity, t.openedStats))}`.replace(/ · $/, '')),
    );

    $('vis-online').replaceChildren(...(d.online.length ? [
      h('span.vis-online-label', h('span.vis-dot'), 'On the site now:'),
      ...d.online.map((o) => h('span.vis-chip', { title: `${o.ip} · ${deviceText(o)} · since ${fullDate(o.since)}` },
        o.label || o.ip, h('small', ` ${o.device}`))),
    ] : []));
    $('vis-online').hidden = !d.online.length;

    renderChart(d);
    renderWho(d.visitors);
    renderBreakdown(d.breakdown, t.views);
    renderRecent(d.recent);
    $('vis-since').textContent = d.trackingSince ? `Tracking since ${new Date(d.trackingSince).toLocaleDateString()} · kept for 90 days` : 'No visits recorded yet';
  }

  // One series (page views), so no legend; unique visitors are in each bar's tooltip.
  function renderChart(d) {
    const s = d.series;
    const max = Math.max(1, ...s.map((p) => p.views));
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    const every = d.hourly ? (narrow ? 8 : 6) : s.length <= 10 ? (narrow ? 2 : 1) : s.length <= 31 ? 7 : narrow ? 30 : 14;
    const label = (p) => (d.hourly
      ? new Date(p.t).toLocaleTimeString([], { hour: 'numeric' })
      : new Date(p.t).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    const tipFor = (p) => {
      const when = d.hourly
        ? `${new Date(p.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}–${new Date(p.t + HOUR).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : new Date(p.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      return `${when}: ${plural(p.views, 'view')} · ${plural(p.visitors, 'visitor')}`;
    };
    $('vis-chart').replaceChildren(
      h('div.vis-axis', h('span', String(max)), h('span', '0')),
      h('div.vis-plot',
        h('div.vis-bars', ...s.map((p) => h('div.vis-col', { 'data-tip': tipFor(p) },
          h('span.vis-bar', { style: { height: `${(p.views / max) * 100}%` }, dataset: { zero: p.views ? '0' : '1' } })))),
        h('div.vis-ticks', ...s.map((p, i) => h('span', (s.length - 1 - i) % every === 0 ? label(p) : '')))),
    );
  }

  function renderWho(list) {
    const head = h('tr', ...['Visitor', 'Country', 'Device', 'Views', 'Days', 'Time', 'Last seen', 'Tabs'].map((x) => h('th', x)));
    const rows = list.map((v) => {
      const input = h('input.vis-label', { value: v.label, maxlength: 40, placeholder: 'Add a name', 'aria-label': `Name for ${v.ip}` });
      input.addEventListener('change', async () => {
        try {
          await api('/api/admin/visits/labels', { method: 'PUT', body: { ip: v.ip, label: input.value } });
          input.blur();
          load();
        } catch (err) { $('vis-msg').textContent = err.message; }
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      return h('tr', { class: v.mine ? 'vis-mine' : null },
        h('td.vis-who', input, h('span.vis-ip', v.ip, v.mine ? h('span.pill.src', 'you') : null, v.returning ? null : h('span.pill.new', 'new'))),
        h('td', { title: v.country || '' }, countryName(v.country)),
        h('td', deviceText(v)),
        h('td.num', String(v.views)),
        h('td.num', String(v.days)),
        h('td.num', fmtDur(v.time)),
        h('td', { title: fullDate(v.last) }, ago(v.last)),
        h('td.muted', tabsText(v.tabs) || '—'));
    });
    $('vis-who').replaceChildren(h('thead', head), h('tbody', ...(rows.length ? rows : [h('tr', h('td.muted', { colSpan: 8 }, 'No visits in this range.'))])));
  }

  function renderRecent(list) {
    const head = h('tr', ...['When', 'Visitor', 'Country', 'Device', 'From', 'Time', 'Tabs'].map((x) => h('th', x)));
    const rows = list.map((v) => h('tr', { class: v.mine ? 'vis-mine' : null },
      h('td', { title: fullDate(v.t) }, ago(v.t)),
      h('td', v.label ? h('span', v.label, h('span.vis-ip.inline', ` ${v.ip}`)) : h('span.vis-ip', v.ip)),
      h('td', countryName(v.country)),
      h('td', deviceText(v)),
      h('td', v.referrer || h('span.muted', 'direct')),
      h('td.num', fmtDur(v.dur)),
      h('td.muted', tabsText(v.tabs) || '—')));
    $('vis-recent').replaceChildren(h('thead', head), h('tbody', ...(rows.length ? rows : [h('tr', h('td.muted', { colSpan: 7 }, 'No visits in this range.'))])));
  }

  function renderBreakdown(b, total) {
    const block = (title, items, opts = {}) => {
      const sum = opts.total ?? items.reduce((s, i) => s + i.n, 0);
      const top = items.slice(0, 6);
      const rest = items.slice(6).reduce((s, i) => s + i.n, 0);
      if (rest) top.push({ name: `${items.length - 6} more`, n: rest, other: true });
      return h('section.vis-block',
        h('h4', title),
        top.length ? h('ul.vis-list', ...top.map((i) => h('li', { 'data-tip': `${i.name}: ${plural(i.n, opts.unit || 'view')}${sum ? ` (${Math.round((i.n / sum) * 100)}%)` : ''}` },
          h('span.vis-name', opts.format ? opts.format(i) : i.name),
          h('span.vis-track', h('span.vis-fill', { style: { width: `${sum ? (i.n / sum) * 100 : 0}%` } })),
          h('span.num', String(i.n))))) : h('p.muted.vis-none', opts.empty || 'None yet'));
    };
    $('vis-breakdown').replaceChildren(
      block('Countries', b.countries, { format: (i) => (i.other ? i.name : countryName(i.name)), empty: 'Cloudflare sends no country (turn on IP Geolocation)' }),
      block('Devices', b.devices),
      block('Browsers', b.browsers),
      block('Systems', b.os),
      block('Came from', b.referrers, { empty: 'All direct (typed, bookmarked or opened from an app)' }),
      block('Bots & link previews', b.bots, { unit: 'hit', empty: 'None' }),
    );
    void total;
  }

  // Tooltip (hover, or tap on phones).
  const tip = $('tip');
  let tipTimer = null;
  function showTip(text, x, y) {
    tip.textContent = text;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
    tip.style.top = `${y - r.height - 12 < 8 ? y + 16 : y - r.height - 12}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  const panel = $('visits-panel');
  panel.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el.dataset.tip, e.clientX, e.clientY); else hideTip();
  });
  panel.addEventListener('pointerleave', hideTip);
  panel.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    showTip(el.dataset.tip, e.clientX, e.clientY);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 2500);
  });

  $('vis-range').addEventListener('change', load);
  $('vis-mine').addEventListener('change', load);
  let armed = false;
  $('vis-clear').addEventListener('click', async () => {
    const btn = $('vis-clear');
    if (!armed) {
      armed = true; btn.textContent = 'Confirm: delete all visit data?';
      setTimeout(() => { armed = false; btn.textContent = 'Clear visitor log'; }, 4000);
      return;
    }
    armed = false; btn.textContent = 'Clear visitor log';
    try { await api('/api/admin/visits', { method: 'DELETE' }); load(); } catch (err) { $('vis-msg').textContent = err.message; }
  });

  window.AdminVisits = {
    start() { load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 30_000); },
    stop() { clearInterval(timer); },
  };
})();
