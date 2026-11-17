'use strict';
/* Shared helpers for the public and admin pages. Everything user-supplied is
   inserted with textContent, never innerHTML. */

window.WF = (() => {
  const MAX_LEVEL = 60;

  // Class colors by Blizzard class id (falls back to the English class name).
  const CLASS_COLORS = {
    1: '#C69B6D', 2: '#F48CBA', 3: '#AAD372', 4: '#FFF468', 5: '#FFFFFF',
    7: '#0070DD', 8: '#3FC7EB', 9: '#8788EE', 11: '#FF7C0A',
  };
  const CLASS_BY_NAME = {
    warrior: 1, paladin: 2, hunter: 3, rogue: 4, priest: 5, shaman: 7, mage: 8, warlock: 9, druid: 11,
  };

  function classColor(data) {
    if (!data) return null;
    return CLASS_COLORS[data.classId] || CLASS_COLORS[CLASS_BY_NAME[(data.className || '').toLowerCase()]] || null;
  }

  /** h('div.cls', {attrs}, ...children) */
  function h(tag, attrs, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') {
        // setProperty handles CSS custom properties (--class), which Object.assign can't.
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function ago(ts, now = Date.now()) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const hr = Math.round(m / 60);
    if (hr < 36) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    if (d < 60) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function countdown(ts, now = Date.now()) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((ts - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fullDate(ts) {
    return ts ? new Date(ts).toLocaleString() : '';
  }

  async function api(url, options = {}) {
    const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (opts.method && opts.method !== 'GET') opts.headers['X-Requested-With'] = 'fetch';
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(json?.error || json?.reason || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function displayName(p) {
    return `${p.data?.name || p.firstName} ${p.data?.surname || p.surname}`;
  }

  function initials(p) {
    return ((p.firstName || '?')[0] + (p.surname || '')[0]).toUpperCase();
  }

  function avatar(p, size = 'md') {
    const color = classColor(p.data);
    const wrap = h(`div.avatar.${size}`, { style: color ? { '--class': color } : null });
    if (p.avatar) {
      const img = h('img', { src: p.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { img.remove(); wrap.textContent = initials(p); });
      wrap.append(img);
    } else {
      wrap.textContent = initials(p);
    }
    return wrap;
  }

  function factionBadge(data) {
    if (!data?.faction) return h('span.muted', '—');
    const t = (data.factionType || data.faction || '').toLowerCase();
    const cls = t.includes('alliance') ? 'alliance' : t.includes('horde') ? 'horde' : 'neutral';
    return h(`span.badge.${cls}`, data.faction);
  }

  function levelCell(p) {
    const lvl = p.data?.level;
    if (lvl == null) return h('div.level.unknown', h('span.lvl-num', '—'));
    const pct = Math.min(100, (lvl / MAX_LEVEL) * 100);
    return h(`div.level${lvl >= MAX_LEVEL ? '.max' : ''}`,
      h('span.lvl-num', String(lvl)),
      h('span.bar', { 'aria-hidden': 'true' }, h('span.fill', { style: { width: `${pct}%` } })),
      p.levelsToday > 0 ? h('span.today', { title: 'Levels gained in the last 24 hours' }, `+${p.levelsToday}`) : null,
    );
  }

  /** "Healer/DPS"-style role pill (guessed from talents), or null. */
  function roleBadge(role, opts = {}) {
    if (!role) return null;
    const parts = [role.primary, role.secondary].filter(Boolean);
    return h(`span.role-badge.r-${parts.join('-')}`, { title: opts.title === false ? null : `${role.split} · guessed from talents` },
      ...parts.map((r) => h(`span.role-dot.r-${r}`, { 'aria-hidden': 'true' })), role.label);
  }

  /** Character name in class color, followed by the nickname if there is one. */
  function nameTag(item) {
    const color = classColor(item);
    // With a slug, the name opens the character panel (#c/<slug>, see character.js).
    return h(item.slug ? 'a.name-tag.char-link' : 'span.name-tag', item.slug ? { href: `#c/${encodeURIComponent(item.slug)}` } : null,
      h('b', { style: color ? { color } : null }, item.name),
      item.nickname ? h('span.nick', item.nickname) : null);
  }

  const LEVEL_TYPES = new Set(['ding', 'milestone', 'max']);
  const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

  /**
   * Folds each character's level-ups on the same (local) day into one entry:
   * { type, from, level, gained, milestones: [20, 30, ...] }. Feed must be newest first.
   * type becomes 'max' if 60 was reached, 'milestone' if any multiple of 10 was, else 'ding'.
   */
  function condenseFeed(items) {
    const out = [];
    const groups = new Map();
    for (const it of items) {
      if (!LEVEL_TYPES.has(it.type)) { out.push(it); continue; }
      const from = it.level - (it.gained || 1);
      const key = `${localDay(it.at)}|${it.playerId || it.name}`;
      let g = groups.get(key);
      if (!g) {
        g = { ...it, from, milestones: [] };
        groups.set(key, g);
        out.push(g);
      } else {
        g.from = Math.min(g.from, from);
        g.level = Math.max(g.level, it.level);
        g.at = Math.max(g.at, it.at);
      }
      for (let l = from + 1; l <= it.level; l++) if (l % 10 === 0 && !g.milestones.includes(l)) g.milestones.push(l);
    }
    for (const g of groups.values()) {
      g.gained = g.level - g.from;
      g.milestones.sort((a, b) => b - a);
      g.type = g.milestones[0] >= MAX_LEVEL ? 'max' : g.milestones.length ? 'milestone' : 'ding';
    }
    return out;
  }

  /** One line of the (condensed) activity feed: level-ups, milestone, max level, join or leave. */
  function feedItem(item, now = Date.now()) {
    let text;
    if (item.type === 'join') text = ['joined the guild', item.level ? h('span.muted', ` · level ${item.level}`) : null];
    else if (item.type === 'leave') text = 'left the guild';
    else if (item.gained > 1) text = [`gained ${item.gained} levels → `, h('strong', String(item.level))];
    else text = ['reached level ', h('strong', String(item.level))];

    let badge = null;
    if (item.type === 'max') badge = h('span.ms-badge.ms-max', 'Level 60 · Max level');
    else if (item.type === 'milestone') badge = h('span.ms-badge', `Level ${item.milestones?.[0] ?? item.level}`);

    return h(`li.feed-item.t-${item.type}`,
      h('span.feed-icon', { 'aria-hidden': 'true' }),
      h('span.feed-text', nameTag(item), ' ', text, badge ? [' ', badge] : null),
      h('time.feed-time', { datetime: new Date(item.at).toISOString(), title: fullDate(item.at) }, ago(item.at, now)),
    );
  }

  return { h, ago, countdown, fullDate, api, classColor, displayName, avatar, factionBadge, levelCell, nameTag, roleBadge, feedItem, condenseFeed, MAX_LEVEL };
})();
