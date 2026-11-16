'use strict';

(() => {
  const { h, ago, countdown, fullDate, api, classColor, displayName, avatar, levelCell, feedItem, condenseFeed, nameTag, MAX_LEVEL } = window.WF;

  const $ = (id) => document.getElementById(id);
  const PAGE = 150;
  const state = {
    players: [], guild: null, poll: null, serverOffset: 0,
    search: '', sort: 'level', minLevel: 0, rank: '', limit: PAGE,
  };

  try {
    state.sort = localStorage.getItem('wf-sort') || 'level';
    state.minLevel = Number(localStorage.getItem('wf-min-level')) || 0;
  } catch { /* storage unavailable */ }
  $('min-level').value = String(state.minLevel);

  const now = () => Date.now() + state.serverOffset;
  const rankOf = (p) => (p.rank == null ? 999 : p.rank);

  const sorters = {
    level: (a, b) => (b.data?.level ?? -1) - (a.data?.level ?? -1) || (b.data?.experience ?? 0) - (a.data?.experience ?? 0) || displayName(a).localeCompare(displayName(b)),
    rank: (a, b) => rankOf(a) - rankOf(b) || sorters.level(a, b),
    name: (a, b) => displayName(a).localeCompare(displayName(b)),
    class: (a, b) => (a.data?.className || '~').localeCompare(b.data?.className || '~') || sorters.level(a, b),
    ilvl: (a, b) => (b.data?.itemLevel ?? -1) - (a.data?.itemLevel ?? -1),
    login: (a, b) => (b.data?.lastLogin ?? 0) - (a.data?.lastLogin ?? 0),
    ding: (a, b) => (b.lastDingAt ?? 0) - (a.lastDingAt ?? 0),
  };

  function matches(p, q) {
    if ((p.data?.level ?? 0) < state.minLevel) return false;
    if (state.rank !== '' && String(p.rank) !== state.rank) return false;
    if (!q) return true;
    const d = p.data || {};
    return [displayName(p), p.nickname, p.note, d.guild, d.className, d.raceName, d.faction, d.ruleset, p.region, p.rankName]
      .some((v) => v && String(v).toLowerCase().includes(q));
  }

  function renderGuild() {
    const g = state.guild;
    const banner = $('guild-banner');
    banner.hidden = !g;

    // Rank sort + filter only make sense with a guild.
    const sortSel = $('sort');
    const rankOpt = sortSel.querySelector('option[value="rank"]');
    if (g && !rankOpt) sortSel.insertBefore(h('option', { value: 'rank' }, 'Guild rank'), sortSel.options[1]);
    if (!g && rankOpt) rankOpt.remove();
    if (!sorters[state.sort] || (state.sort === 'rank' && !g)) state.sort = 'level';
    sortSel.value = state.sort;

    $('rank-filter-wrap').hidden = !g || !g.ranks.length;
    if (!g) return;

    const sel = $('rank-filter');
    const current = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'All'), ...g.ranks.map((r) => h('option', { value: String(r.rank) }, r.name)));
    sel.value = g.ranks.some((r) => String(r.rank) === current) ? current : '';
    state.rank = sel.value;

    const t = (g.factionType || g.faction || '').toLowerCase();
    const crest = t.includes('alliance') ? 'alliance' : t.includes('horde') ? 'horde' : 'neutral';
    const bits = [g.faction, g.ruleset, g.region?.toUpperCase(), g.memberCount != null ? `${g.memberCount} members` : null].filter(Boolean);
    banner.replaceChildren(
      h(`span.crest.${crest}`, { 'aria-hidden': 'true' }),
      h('span.guild-name', `<${g.name}>`),
      h('span.guild-meta', bits.join(' · ')),
    );
  }

  function renderStats() {
    const known = state.players.filter((p) => p.data?.level != null);
    const levels = known.map((p) => p.data.level);
    const avg = levels.length ? (levels.reduce((a, b) => a + b, 0) / levels.length).toFixed(1) : '—';
    const capped = levels.filter((l) => l >= MAX_LEVEL).length;
    const top = known.slice().sort(sorters.level)[0];
    const dingsToday = state.players.reduce((s, p) => s + (p.levelsToday || 0), 0);

    const stat = (label, value, sub) => h('div.stat', h('span.stat-val', value), h('span.stat-label', label), sub ? h('span.stat-sub', sub) : null);
    $('stats').replaceChildren(
      stat(state.guild ? 'Characters' : 'Adventurers', String(state.players.length)),
      stat('Average level', String(avg)),
      stat(`At level ${MAX_LEVEL}`, String(capped)),
      stat('Levels today', String(dingsToday)),
      stat('Leading', top ? String(top.data.level) : '—', top ? displayName(top) + (top.nickname ? ` (${top.nickname})` : '') : null),
    );

    // Class mix (respects the level filter so "who's at 60" is easy to see).
    const counts = new Map();
    for (const p of state.players) {
      if (!p.data?.className || (p.data.level ?? 0) < state.minLevel) continue;
      const c = counts.get(p.data.className) || { n: 0, color: classColor(p.data) };
      c.n++;
      counts.set(p.data.className, c);
    }
    const chips = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, c]) =>
      h('button.chip', { type: 'button', style: c.color ? { '--class': c.color } : null, title: `Show ${name}s`, onclick: () => { $('search').value = name; state.search = name; state.limit = PAGE; renderRows(); } },
        h('span.chip-dot', { 'aria-hidden': 'true' }), name, h('b', String(c.n))));
    $('class-mix').replaceChildren(...chips);
    $('class-mix').hidden = chips.length < 2;

    renderOverview({ known, levels, avg, capped, top, dingsToday });
    renderClassList(counts);
  }

  /** Wide layout: guild-wide numbers as a label/value list. */
  function renderOverview({ known, levels, avg, capped, top, dingsToday }) {
    const t = now();
    const sorted = levels.slice().sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
    const loggedIn = (ms) => state.players.filter((p) => p.data?.lastLogin && t - p.data.lastLogin <= ms).length;
    const ilvls = state.players.map((p) => p.data?.itemLevel).filter((v) => v != null);
    const avgIlvl = ilvls.length ? (ilvls.reduce((a, b) => a + b, 0) / ilvls.length).toFixed(1) : null;
    // People: characters grouped by the first word of their nickname ("Travis Mage Alt" -> Travis).
    const nicked = state.players.filter((p) => p.nickname);
    const people = new Set(state.players.map((p) => (p.nickname ? `n:${p.nickname.split(/\s+/)[0].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()}` : `c:${p.id}`)));
    const week = state.guildWeek;

    // Related numbers share a row ("a / b") so the card stays short enough for the
    // whole left column to fit on a 1080p screen without scrolling.
    const weekTip = week
      ? `Today = last 24 hours. Week: ${week.levelers} character${week.levelers === 1 ? '' : 's'} gained levels${week.days > 0 && week.days < 6.5 ? `; tracking began ${Math.max(1, Math.round(week.days))} day${Math.round(week.days) > 1 ? 's' : ''} ago` : ' in the last 7 days'}`
      : 'Levels gained in the last 24 hours';
    const rows = [
      [state.guild ? 'Characters' : 'Adventurers', String(state.players.length)],
      nicked.length ? ['People', String(people.size), 'Characters grouped by the first word of their nickname'] : null,
      median != null ? ['Avg / median level', `${avg} / ${median}`] : ['Average level', String(avg)],
      [`At level ${MAX_LEVEL} / 50+`, `${capped} / ${levels.filter((l) => l >= 50).length}`],
      week ? ['Levels today / week', `${dingsToday} / ${week.levels}`, weekTip] : ['Levels today', String(dingsToday)],
      ['Played today / week', `${loggedIn(24 * 3600e3)} / ${loggedIn(7 * 24 * 3600e3)}`, 'Characters that logged out in the last 24 hours / 7 days'],
      avgIlvl ? ['Avg item level', avgIlvl] : null,
    ].filter(Boolean);
    $('overview-list').replaceChildren(
      ...rows.flatMap(([k, v, tip]) => [h('dt', { title: tip || null }, k), h('dd', v)]),
      ...(top ? [h('dt', 'Leading'), h('dd.kv-lead', h('b', String(top.data.level)), ' ', nameTag({ ...top.data, name: displayName(top), nickname: '' }))] : []),
    );
  }

  /** Wide layout: class breakdown as a list with a thin bar; click to filter the roster. */
  function renderClassList(counts) {
    const entries = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
    const total = entries.reduce((s, [, c]) => s + c.n, 0);
    const max = Math.max(1, ...entries.map(([, c]) => c.n));
    $('class-card-sub').textContent = state.minLevel ? `Level ${state.minLevel}+` : '';
    $('class-list').replaceChildren(...entries.map(([name, c]) => {
      const active = state.search.trim().toLowerCase() === name.toLowerCase();
      return h('li', h('button.class-row', {
        type: 'button', 'aria-pressed': active ? 'true' : 'false', style: c.color ? { '--class': c.color } : null,
        title: active ? 'Show all classes' : `Show only ${name}s`,
        onclick: () => {
          const next = active ? '' : name;
          $('search').value = next; state.search = next; state.limit = PAGE; renderRows(); renderClassList(counts);
        },
      },
      h('span.class-name', name),
      h('span.class-bar', h('span', { style: { width: `${(c.n / max) * 100}%` } })),
      h('span.class-count', String(c.n)),
      h('span.class-pct', total ? `${Math.round((c.n / total) * 100)}%` : '')));
    }));
  }

  function row(p, i) {
    const d = p.data || {};
    const color = classColor(d);

    const charCell = h('div.char',
      avatar(p),
      h('div.char-text',
        h('span.char-name', { style: color ? { color } : null }, displayName(p)),
        h('span.char-sub',
          p.nickname ? h('span.nick', p.nickname) : null,
          p.inGuild ? h('span.rank-name', p.rankName) : d.guild ? h('span.guild', `<${d.guild}>`) : null,
          p.note ? h('span.note', p.note) : null,
          p.hint ? h('span.pending', p.hint) : null,
        ),
      ),
    );

    return h('div.row', { role: 'row', dataset: { status: p.status, profile: p.hasProfile ? '1' : '0' } },
      h('span.rank', String(i + 1)),
      charCell,
      h('span.c-level', { 'data-label': 'Level' }, levelCell(p)),
      h('span.c-class', { 'data-label': 'Class', style: color ? { color } : null }, d.className || '—'),
      h('span.c-race', { 'data-label': 'Race' }, d.raceName || '—'),
      h('span.c-ilvl', { 'data-label': 'Item Level' }, d.itemLevel != null ? String(d.itemLevel) : '—'),
      h('span.c-login', { 'data-label': 'Last Login', title: fullDate(d.lastLogin) }, ago(d.lastLogin, now())),
      h(p.lastDingAt ? 'span.c-ding' : 'span.c-ding.none', { 'data-label': 'Last Ding', title: p.lastDingAt ? `Last level-up: ${fullDate(p.lastDingAt)}` : null },
        p.lastDingAt ? ago(p.lastDingAt, now()) : '—'),
      // Phone layout only (hidden on desktop): race + class, and one compact info line.
      h('span.m-rc', d.raceName || '', d.raceName && d.className ? ' ' : '', d.className ? h('span', { style: color ? { color } : null }, d.className) : null),
      h('span.m-meta', ...mobileMeta(p, d)),
    );
  }

  function mobileMeta(p, d) {
    const parts = [];
    if (d.itemLevel != null) parts.push(h('span', 'Item Lvl ', h('b', String(d.itemLevel))));
    if (d.lastLogin) parts.push(h('span', 'Login ', h('b', ago(d.lastLogin, now()))));
    if (p.lastDingAt) parts.push(h('span.m-ding', 'Ding ', h('b', ago(p.lastDingAt, now()))));
    return parts.flatMap((el, i) => (i ? [' · ', el] : [el]));
  }

  function renderRows() {
    const q = state.search.trim().toLowerCase();
    const list = state.players.filter((p) => matches(p, q)).sort(sorters[state.sort] || sorters.level);
    $('rows').replaceChildren(...list.slice(0, state.limit).map(row));
    $('empty').hidden = list.length > 0;
    $('empty').textContent = state.players.length ? 'No players match your filters.' : 'No players on the roster yet.';
    $('more').hidden = list.length <= state.limit;
    $('show-more').textContent = `Show more (${list.length - state.limit} left)`;
  }

  // 8 lines are rendered; narrow layouts show the first 3 (see .recent in styles.css).
  function renderRecent(items) {
    const lines = condenseFeed(items).slice(0, 8);
    $('recent').hidden = !lines.length;
    $('recent-list').replaceChildren(...lines.map((it) => feedItem(it, now())));
  }

  // "XP waste" wall: characters not seen for 2+ days, longest first. Over 14 days counts as
  // abandoned and drops off until the character logs in again; level 60s can't waste XP, so
  // they're left out. Wide layouts show the top 5 beside the title; elsewhere the Shame tab
  // shows everyone.
  const SHAME_MIN = 2 * 24 * 3600e3;
  const ABANDONED = 14 * 24 * 3600e3;
  function offlineFor(ms) {
    const hours = Math.floor(ms / 3600e3);
    const days = Math.floor(hours / 24);
    return days >= 10 ? `${days}d` : `${days}d ${hours % 24}h`;
  }
  function shameRow({ p, ms }) {
    const sev = ms >= 10 * 24 * 3600e3 ? 3 : ms >= 5 * 24 * 3600e3 ? 2 : 1;
    return h('li',
      h('span.shame-name', nameTag({ ...p.data, name: displayName(p), nickname: p.nickname })),
      h('span.shame-level', String(p.data.level)),
      h(`span.shame-time.sev-${sev}`, { title: `Last seen ${fullDate(p.data.lastLogin)}` }, offlineFor(ms)));
  }
  function renderShame() {
    const t = now();
    const away = state.players
      .filter((p) => p.data?.lastLogin && (p.data.level ?? 0) < MAX_LEVEL)
      .map((p) => ({ p, ms: t - p.data.lastLogin }))
      .filter((x) => x.ms >= SHAME_MIN)
      .sort((a, b) => b.ms - a.ms);
    const wall = away.filter((x) => x.ms <= ABANDONED);
    const gone = away.filter((x) => x.ms > ABANDONED);
    const emptyText = 'Nobody is slacking. Everyone has played in the last 2 days.';

    // Header card: fixed size, the 5 longest offline, then a count of the rest.
    const more = wall.slice(HEADER_ROWS);
    $('shame-list').replaceChildren(...padRows(wall.slice(0, HEADER_ROWS).map(shameRow), emptyText));
    const foot = [];
    if (more.length) {
      foot.push(h('span', { title: more.map(({ p, ms }) => `${displayName(p)}${p.nickname ? ` (${p.nickname})` : ''} · ${offlineFor(ms)}`).join('\n') },
        `+${more.length} more offline`));
    }
    if (gone.length) foot.push(h('span', { title: 'Offline 14+ days. They come back here once they log in again.' }, `${gone.length} abandoned`));
    $('shame-foot').replaceChildren(...foot.flatMap((el, i) => (i ? [' · ', el] : [el])));

    // Shame tab: everyone.
    $('shame-all').replaceChildren(...(wall.length ? wall.map(shameRow) : [h('li.row-empty', emptyText)]));
    $('shame-all-sub').textContent = wall.length ? `${wall.length} offline 2+ days, longest first` : 'Offline 2+ days';
    $('abandoned-wrap').hidden = !gone.length;
    $('abandoned-all').replaceChildren(...gone.map(shameRow));
  }

  // Both header cards always show HEADER_ROWS lines so they keep the same shape; spare
  // lines are blank placeholders, and an empty list puts its message on the first one.
  const HEADER_ROWS = 5;
  function padRows(items, emptyMessage) {
    const out = items.slice();
    if (!out.length) out.push(h('li.row-empty', emptyMessage));
    while (out.length < HEADER_ROWS) out.push(h('li.row-ph', { 'aria-hidden': 'true' }, ' '));
    return out;
  }

  // Who is closest to their next multiple of 10. Nearest first; ties go to whoever is leveling
  // right now (levels today, then most recent level-up). Skips 60s and abandoned characters,
  // same rules as the hall of shame. Top 5 beside the title on wide layouts, all in the
  // Milestones tab elsewhere.
  function milestoneRow({ p, level, next, toGo }) {
    return h('li',
      h('span.mini-name', nameTag({ ...p.data, name: displayName(p), nickname: p.nickname })),
      h('span.ms-step', String(level), h('span.ms-arrow', '→'), h('b', String(next))),
      h(`span.ms-togo${toGo === 1 ? '.ms-close' : ''}`, toGo === 1 ? '1 level' : `${toGo} levels`));
  }
  function renderNextMilestones() {
    const t = now();
    const all = state.players
      .filter((p) => p.data?.level != null && p.data.level < MAX_LEVEL)
      .filter((p) => !p.data.lastLogin || t - p.data.lastLogin <= ABANDONED)
      .map((p) => {
        const level = p.data.level;
        const next = Math.floor(level / 10) * 10 + 10;
        return { p, level, next, toGo: next - level };
      })
      .sort((a, b) => a.toGo - b.toGo || (b.p.levelsToday || 0) - (a.p.levelsToday || 0)
        || (b.p.lastDingAt || 0) - (a.p.lastDingAt || 0) || b.level - a.level);
    const emptyText = 'Everyone tracked is already level 60.';
    $('next-ms-list').replaceChildren(...padRows(all.slice(0, HEADER_ROWS).map(milestoneRow), emptyText));
    const oneAway = all.filter((r) => r.toGo === 1).length;
    const summary = oneAway
      ? `${oneAway} character${oneAway === 1 ? ' is' : 's are'} one level from a milestone`
      : all.length ? 'Nobody is one level away right now' : '';
    $('next-ms-foot').textContent = summary;

    $('ms-all').replaceChildren(...(all.length ? all.map(milestoneRow) : [h('li.row-empty', emptyText)]));
    $('ms-all-sub').textContent = summary || 'Closest to the next 10';
  }

  // Wide layout only: this week's top 5 by levels gained.
  function renderTopLevelers(rows) {
    $('top-week').hidden = !rows.length;
    $('top-week-list').replaceChildren(...rows.map((r) => h('li',
      h('span.top-name', nameTag(r)),
      h('span.top-gain', `+${r.gained}`),
      h('span.top-level', String(r.level)))));
  }

  function renderPollStatus() {
    const poll = state.poll;
    if (!poll) return;
    const last = poll.lastPoll?.finishedAt;
    const parts = [];
    parts.push(last ? `Updated ${ago(last, now())}` : 'Waiting for first update');
    if (poll.polling) parts.push('checking Blizzard now…');
    else if (poll.nextPollAt) parts.push(`next check in ${countdown(poll.nextPollAt, now())}`);
    $('poll-status').textContent = parts.join(' · ');
  }

  async function load() {
    try {
      const data = await api('/api/players');
      state.serverOffset = data.serverTime - Date.now();
      state.players = data.players;
      state.guild = data.guild;
      state.guildWeek = data.guildWeek || null;
      state.poll = data;
      renderGuild();
      renderStats();
      renderRecent(data.recentActivity || []);
      renderShame();
      renderNextMilestones();
      renderTopLevelers(data.topLevelers || []);
      renderRows();
      renderPollStatus();
    } catch (err) {
      $('poll-status').textContent = `Couldn't reach the server (${err.message}). Retrying…`;
    }
  }

  async function loadSite() {
    try {
      const site = await api('/api/site');
      $('site-title').textContent = site.title;
      document.title = site.title;
    } catch { /* keep defaults */ }
  }

  const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

  $('search').addEventListener('input', (e) => { state.search = e.target.value; state.limit = PAGE; renderRows(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; save('wf-sort', state.sort); renderRows(); });
  $('min-level').addEventListener('change', (e) => {
    state.minLevel = Number(e.target.value) || 0; state.limit = PAGE; save('wf-min-level', String(state.minLevel));
    renderStats(); renderRows();
  });
  $('rank-filter').addEventListener('change', (e) => { state.rank = e.target.value; state.limit = PAGE; renderRows(); });
  $('show-more').addEventListener('click', () => { state.limit += PAGE; renderRows(); });

  loadSite();
  load();
  // Poll only while the tab is visible (coming back to it reloads straight away, below).
  setInterval(() => { if (!document.hidden) load(); }, 30_000);
  setInterval(renderPollStatus, 1_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
