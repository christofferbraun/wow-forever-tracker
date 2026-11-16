'use strict';

/* Tabs (Roster / Activity / Stats) plus the Activity and Stats views. */
(() => {
  const { h, ago, fullDate, api, feedItem, nameTag, MAX_LEVEL } = window.WF;
  const $ = (id) => document.getElementById(id);
  const VIEWS = ['roster', 'activity', 'stats'];
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const PACE_TOP = 10;

  let view = 'roster';
  let serverOffset = 0;
  let refreshTimer = null;
  const now = () => Date.now() + serverOffset;

  // --- tabs -------------------------------------------------------------------

  function show(next) {
    view = VIEWS.includes(next) ? next : 'roster';
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
    for (const a of document.querySelectorAll('.tabs a')) {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    hideTip();
    clearInterval(refreshTimer);
    if (view === 'activity') { loadFeed(true); refreshTimer = setInterval(() => loadFeed(true), 60_000); }
    if (view === 'stats') { loadStats(); refreshTimer = setInterval(loadStats, 60_000); }
  }
  window.addEventListener('hashchange', () => { show(location.hash.slice(1)); window.scrollTo({ top: 0 }); });

  // --- tooltip (hover on desktop, tap on phones) -------------------------------

  const tip = $('tip');
  let tipTimer = null;
  function showTip(text, x, y) {
    tip.textContent = text;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() { tip.hidden = true; }

  $('view-stats').addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el.dataset.tip, e.clientX, e.clientY);
    else if (!e.target.closest('.chart')) hideTip();
  });
  $('view-stats').addEventListener('pointerleave', hideTip);
  $('view-stats').addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    showTip(el.dataset.tip, e.clientX, e.clientY);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, 2500);
  });

  // --- activity ---------------------------------------------------------------

  let feedItems = [];

  function dayLabel(t) {
    const d = new Date(t), today = new Date(now());
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(today) - startOf(d)) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function renderFeed(hasMore) {
    const groups = [];
    for (const it of feedItems) {
      const label = dayLabel(it.at);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
      groups[groups.length - 1].items.push(it);
    }
    $('feed').replaceChildren(...groups.map((g) => h('div.feed-day',
      h('h3.feed-date', g.label),
      h('ul.feed', g.items.map((it) => feedItem(it, now()))))));
    $('feed-empty').hidden = feedItems.length > 0;
    $('feed-more-wrap').hidden = !hasMore;
    $('feed-sub').textContent = 'Level-ups, milestones, joins and leaves';
  }

  async function loadFeed(reset) {
    try {
      const before = !reset && feedItems.length ? feedItems[feedItems.length - 1].at : '';
      const data = await api(`/api/activity?limit=50${before ? `&before=${before}` : ''}`);
      serverOffset = data.serverTime - Date.now();
      // On a refresh, keep however many older items were already loaded.
      if (reset) {
        const keep = Math.max(50, feedItems.length);
        feedItems = data.items.length < keep && feedItems.length > data.items.length
          ? mergeFeed(data.items, feedItems).slice(0, keep) : data.items;
      } else {
        feedItems = feedItems.concat(data.items);
      }
      renderFeed(data.items.length === 50);
    } catch (err) {
      $('feed-sub').textContent = `Couldn't load activity (${err.message})`;
    }
  }

  function mergeFeed(fresh, old) {
    const key = (it) => `${it.type}|${it.at}|${it.name}|${it.level}`;
    const seen = new Set(fresh.map(key));
    return fresh.concat(old.filter((it) => !seen.has(key(it)))).sort((a, b) => b.at - a.at);
  }

  $('feed-more').addEventListener('click', () => loadFeed(false));

  // --- stats ------------------------------------------------------------------

  let statsData = null;
  let paceAll = false;

  async function loadStats() {
    try {
      statsData = await api('/api/stats');
      serverOffset = statsData.serverTime - Date.now();
      renderStats();
    } catch (err) {
      $('pace-sub').textContent = `Couldn't load stats (${err.message})`;
    }
  }

  function renderStats() {
    if (!statsData || view !== 'stats') return;
    renderPace();
    renderTrend();
    renderDist();
    renderHeat();
  }

  function shortDate(t) { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function trackedFor() {
    const since = statsData.trackingSince;
    return since ? now() - since : 0;
  }

  // Race to 60
  function renderPace() {
    const rows = statsData.pace;
    const tracked = trackedFor();
    $('pace-sub').textContent = tracked >= 7 * DAY ? 'Levels gained in the last 7 days'
      : tracked >= DAY ? `Levels gained since tracking began ${Math.floor(tracked / DAY)} day${tracked >= 2 * DAY ? 's' : ''} ago`
      : 'Levels gained since tracking began today · pace and dates appear after a day';

    const list = paceAll ? rows : rows.slice(0, PACE_TOP);
    const head = h('div.pace-row.head', { role: 'row' },
      h('span', '#'), h('span', 'Character'), h('span', 'Level'), h('span', 'Gained'), h('span', 'Per day'), h('span', 'Level 60 by'));
    $('pace').replaceChildren(head, ...list.map((r, i) => {
      const perDay = r.perDay == null ? '—' : r.perDay >= 10 ? r.perDay.toFixed(0) : r.perDay.toFixed(1);
      let eta = '—';
      if (r.level >= MAX_LEVEL) eta = 'Max level';
      else if (r.eta && r.eta - now() < 365 * DAY) eta = shortDate(r.eta);
      return h('div.pace-row', { role: 'row' },
        h('span.pace-rank', String(i + 1)),
        h('span.pace-name', nameTag(r)),
        h('span.pace-level', String(r.level)),
        h('span.pace-gained', { 'data-label': 'Gained' }, r.gained > 0 ? h('b', `+${r.gained}`) : '0'),
        h('span.pace-rate', { 'data-label': 'Per day' }, perDay),
        h('span.pace-eta', { 'data-label': '60 by', title: r.eta ? fullDate(r.eta) : null }, eta),
        // Phone layout only: the three columns above as one line.
        h('span.pace-m',
          r.gained > 0 ? h('b.up', `+${r.gained}`) : h('b', '0'), ` level${r.gained === 1 ? '' : 's'}`,
          perDay !== '—' ? [' · ', h('b', perDay), '/day'] : null,
          eta === 'Max level' ? [' · ', h('b', 'Max level')] : eta !== '—' ? [' · 60 by ', h('b', eta)] : null),
      );
    }));
    $('pace-more-wrap').hidden = rows.length <= PACE_TOP;
    $('pace-more').textContent = paceAll ? 'Show top 10' : `Show all ${rows.length}`;
  }
  $('pace-more').addEventListener('click', () => { paceAll = !paceAll; renderPace(); });

  // Average level over time: one series, so no legend; crosshair + tooltip on hover/drag.
  function renderTrend() {
    const { points, bucketHours } = statsData.trend;
    const box = $('trend');
    const last = points[points.length - 1];
    $('trend-sub').textContent = last ? `Now ${last.avg} across ${last.count} characters` : '';
    if (points.length < 3) {
      box.replaceChildren(h('p.chart-empty', 'The trend line fills in after a few hours of tracking.'));
      return;
    }
    const W = Math.max(260, box.clientWidth), H = W < 500 ? 160 : 200;
    const m = { t: 10, r: 10, b: 24, l: 28 };
    const t0 = points[0].t, t1 = last.t;
    const yMax = Math.min(MAX_LEVEL, Math.max(10, Math.ceil(Math.max(...points.map((p) => p.avg)) / 10) * 10 + 10));
    const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
    const y = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);
    const NS = 'http://www.w3.org/2000/svg';
    const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Average level over time, now ${last.avg}` });
    // Recessive grid + y labels
    for (let v = 0; v <= yMax; v += yMax > 30 ? 20 : 10) {
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }));
      const lbl = s('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }); lbl.textContent = String(v); svg.append(lbl);
    }
    // X labels: ~4 ticks
    const fmt = bucketHours >= 24 ? (t) => shortDate(t)
      : (t) => new Date(t).toLocaleString(undefined, t1 - t0 > DAY ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric' });
    const ticks = W < 500 ? 3 : 4;
    for (let i = 0; i < ticks; i++) {
      const t = t0 + ((t1 - t0) * i) / (ticks - 1);
      const lbl = s('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle', class: 'axis' });
      lbl.textContent = fmt(t); svg.append(lbl);
    }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
    svg.append(s('path', { d: `${d}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`, class: 'area' }));
    svg.append(s('path', { d, class: 'line' }));
    const cross = s('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' });
    const dot = s('circle', { r: 4, class: 'dot', visibility: 'hidden' });
    svg.append(cross, dot);
    const hit = s('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' });
    svg.append(hit);

    const pointLabel = (p) => `${new Date(p.t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })}\nAverage ${p.avg} · highest ${p.max} · ${p.count} characters`;
    const onMove = (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      let best = points[0];
      for (const p of points) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(best.t)); dot.setAttribute('cy', y(best.avg)); dot.setAttribute('visibility', 'visible');
      showTip(pointLabel(best), rect.left + (x(best.t) / W) * rect.width, rect.top + (y(best.avg) / H) * rect.height);
    };
    const onLeave = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerdown', onMove);
    hit.addEventListener('pointerleave', onLeave);
    box.replaceChildren(svg);
  }

  // Level spread: horizontal bars, each directly labeled with its count.
  function renderDist() {
    const bands = statsData.distribution;
    const total = bands.reduce((a, b) => a + b.count, 0);
    const max = Math.max(1, ...bands.map((b) => b.count));
    $('dist-sub').textContent = total ? `${total} characters` : '';
    $('dist').replaceChildren(...bands.map((b) => h('div.dist-row', { 'data-tip': `Level ${b.label}: ${b.count} character${b.count === 1 ? '' : 's'}${total ? ` (${Math.round((b.count / total) * 100)}%)` : ''}` },
      h('span.dist-label', b.label),
      h('span.dist-track', h('span.dist-bar', { style: { width: b.count ? `${Math.max(2, (b.count / max) * 100)}%` : '0' } })),
      h('span.dist-count', String(b.count)),
    )));
  }

  // Logout heatmap, shifted from UTC to the viewer's time zone.
  function renderHeat() {
    const { counts, total } = statsData.heatmap;
    const shift = Math.round(-new Date().getTimezoneOffset() / 60);
    const local = new Array(168).fill(0);
    counts.forEach((c, i) => { local[(((i + shift) % 168) + 168) % 168] += c; });
    const max = Math.max(1, ...local);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hourName = (hr) => new Date(2000, 0, 1, hr).toLocaleTimeString(undefined, { hour: 'numeric' });

    $('heat-sub').textContent = total < 30
      ? `Logouts in your local time · ${total} so far, fills in over the coming weeks`
      : `Logouts in the last 28 days, in your local time`;
    const cells = [h('span.heat-corner')];
    for (let hr = 0; hr < 24; hr++) cells.push(h('span.heat-hour', hr % 6 === 0 ? hourName(hr) : ''));
    days.forEach((day, di) => {
      cells.push(h('span.heat-day', day));
      for (let hr = 0; hr < 24; hr++) {
        const c = local[di * 24 + hr];
        const strength = c ? 0.18 + 0.82 * (c / max) : 0;
        cells.push(h('span.heat-cell', {
          style: { '--a': strength.toFixed(2) },
          'data-tip': `${day} ${hourName(hr)}: ${c} logout${c === 1 ? '' : 's'}`,
        }));
      }
    });
    $('heat').replaceChildren(...cells);
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => statsData && view === 'stats' && renderTrend(), 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && view !== 'roster') show(view); });

  show(location.hash.slice(1));
})();
