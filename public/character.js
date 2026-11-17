'use strict';

/*
 * Character panel. Opens over the current tab at #c/<first-surname>, so links can be
 * shared. Any <a href="#c/..."> on the page opens it (names in the roster, feed, etc.).
 */
(() => {
  const { h, ago, fullDate, api, classColor, avatar, displayName, roleBadge } = window.WF;

  const TABS = [
    ['gear', 'Gear'], ['stats', 'Stats'], ['talents', 'Talents'],
    ['professions', 'Professions'], ['reputation', 'Reputation'], ['fun', 'Fun facts'],
  ];
  const SLOT_NAMES = {
    HEAD: 'Head', NECK: 'Neck', SHOULDER: 'Shoulders', BACK: 'Back', CHEST: 'Chest', SHIRT: 'Shirt', TABARD: 'Tabard',
    WRIST: 'Wrist', HANDS: 'Hands', WAIST: 'Waist', LEGS: 'Legs', FEET: 'Feet', FINGER_1: 'Ring', FINGER_2: 'Ring',
    TRINKET_1: 'Trinket', TRINKET_2: 'Trinket', MAIN_HAND: 'Main Hand', OFF_HAND: 'Off Hand', RANGED: 'Ranged',
  };
  const LEFT = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'SHIRT', 'TABARD', 'WRIST'];
  const RIGHT = ['HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2'];
  const BOTTOM = ['MAIN_HAND', 'OFF_HAND', 'RANGED'];

  let tab = 'gear';
  try { tab = sessionStorage.getItem('cp-tab') || 'gear'; } catch { /* storage blocked */ }
  if (!TABS.some(([k]) => k === tab)) tab = 'gear';

  let overlay = null;
  let data = null;
  let openSlug = null;
  let pushed = false;      // opened by navigating within the page (so Back closes it)
  let returnFocus = null;
  let reqId = 0;

  const fmt = (n, digits = 0) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}%`);

  // --- shell -----------------------------------------------------------------------

  function build() {
    overlay = h('div.cp-overlay', { hidden: true },
      h('div.cp-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cp-title' },
        h('header.cp-head', { id: 'cp-head' }),
        h('nav.cp-tabs', { role: 'tablist', id: 'cp-tabs' }),
        h('div.cp-body', { id: 'cp-body' })),
      h('div.item-tip', { id: 'item-tip', hidden: true }));
    document.body.append(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (overlay.hidden) return;
      if (e.key === 'Escape') { if (!tipEl().hidden && tipPinned) hideTip(true); else close(); }
    });
    wireTips();
  }

  const $ = (id) => document.getElementById(id);

  function slugFromHash() {
    const m = /^#c\/([^/?#]+)/.exec(location.hash);
    if (!m) return null;
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
  }

  async function open(slug) {
    if (!overlay) build();
    if (overlay.hidden) {
      returnFocus = document.activeElement;
      overlay.hidden = false;
      document.body.classList.add('cp-open');
    }
    if (slug === openSlug && data) return;
    openSlug = slug;
    data = null;
    hideTip(true);
    renderHead(null, slug);
    renderTabs(false);
    $('cp-body').replaceChildren(h('p.cp-loading', 'Loading character…'));
    $('cp-close')?.focus();
    const id = ++reqId;
    try {
      const res = await api(`/api/characters/${encodeURIComponent(slug)}`);
      if (id !== reqId) return;
      data = res;
      renderHead(res.player, slug, res);
      renderTabs(true);
      renderBody();
    } catch (err) {
      if (id !== reqId) return;
      $('cp-body').replaceChildren(h('p.cp-error', err.message || 'Could not load this character.'));
    }
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    if (slugFromHash()) {
      if (pushed) { history.back(); return; } // hashchange will finish closing
      history.replaceState(null, '', location.pathname + location.search);
    }
    finishClose();
  }

  function finishClose() {
    reqId++;
    hideTip(true);
    overlay.hidden = true;
    document.body.classList.remove('cp-open');
    openSlug = null;
    data = null;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  }

  window.addEventListener('hashchange', () => {
    const slug = slugFromHash();
    if (slug) { if (!overlay || overlay.hidden) pushed = true; open(slug); } else if (overlay && !overlay.hidden) finishClose();
  });

  // --- header + tabs -------------------------------------------------------------

  function renderHead(p, slug, res) {
    const d = p?.data || {};
    const color = classColor(d);
    const name = p ? displayName(p) : slug.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    const line1 = [
      d.level != null ? `Level ${d.level}` : null,
      [d.raceName, d.className].filter(Boolean).join(' ') || null,
    ].filter(Boolean).join(' ');
    const meta = [];
    if (p?.nickname) meta.push(h('span.nick', p.nickname));
    if (line1) meta.push(h('span', line1));
    if (p?.role) meta.push(roleBadge(p.role));
    if (p?.inGuild && p.rankName) meta.push(h('span.guild', `${p.rankName} of <${d.guild}>`));
    else if (d.guild) meta.push(h('span.guild', `<${d.guild}>`));

    const facts = [];
    if (d.itemLevel != null) facts.push(h('span', 'Item level ', h('b', String(d.itemLevel))));
    if (res?.achievements?.count) facts.push(h('span', 'Achievements ', h('b', String(res.achievements.count))));
    if (d.lastLogin) facts.push(h('span', { title: fullDate(d.lastLogin) }, 'Last login ', h('b', ago(d.lastLogin))));
    if (res?.fetchedAt) {
      facts.push(h('span.cp-fresh', { title: `Fetched from Blizzard ${fullDate(res.fetchedAt)}. Blizzard updates characters when they log out.` },
        res.stale ? 'Blizzard unreachable, showing older data' : 'As of their last logout'));
    }

    $('cp-head').replaceChildren(
      p ? avatar(p, 'lg') : h('div.avatar.lg'),
      h('div.cp-title',
        h('h2', { id: 'cp-title', style: color ? { color } : null }, name),
        meta.length ? h('div.cp-meta', ...meta) : null,
        facts.length ? h('div.cp-facts', ...facts) : null),
      h('button.cp-close', { id: 'cp-close', type: 'button', 'aria-label': 'Close' }, '×'));
    $('cp-close').addEventListener('click', close);
  }

  function renderTabs(enabled) {
    const nav = $('cp-tabs');
    nav.replaceChildren(...TABS.map(([key, label]) => {
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': key === tab ? 'true' : 'false', disabled: !enabled }, label);
      b.addEventListener('click', () => {
        tab = key;
        try { sessionStorage.setItem('cp-tab', key); } catch { /* ignore */ }
        renderTabs(true);
        renderBody();
      });
      return b;
    }));
    nav.hidden = false;
  }

  function renderBody() {
    hideTip(true);
    const body = $('cp-body');
    const render = { gear: renderGear, stats: renderStats, talents: renderTalents, professions: renderProfessions, reputation: renderReputation, fun: renderFun }[tab];
    body.replaceChildren(...[].concat(render(data)));
    body.scrollTop = 0;
  }

  const empty = (text) => h('p.cp-empty', text);

  // --- gear ------------------------------------------------------------------------

  function slotEl(type, gearBySlot) {
    const it = gearBySlot[type];
    if (!it) {
      return h('div.slot.empty', h('span.slot-icon'), h('span.slot-text', h('span.slot-sub', SLOT_NAMES[type])));
    }
    const sub = [it.ilvl != null ? `ilvl ${it.ilvl}` : null, it.subclass || it.type].filter(Boolean).join(' · ');
    const icon = h('span.slot-icon', it.icon ? h('img', { src: it.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null);
    return h(`button.slot.q-${it.quality}`, { type: 'button', dataset: { slot: type }, 'aria-label': `${SLOT_NAMES[type]}: ${it.name}` },
      icon,
      h('span.slot-text', h('span.slot-name', it.name), h('span.slot-sub', sub)));
  }

  function renderGear(d) {
    const gear = d.gear || [];
    if (!gear.length) return empty(d.missing?.includes('equipment') ? 'Blizzard sent no gear for this character.' : 'Nothing equipped.');
    const bySlot = Object.fromEntries(gear.map((i) => [i.slot, i]));
    const ilvl = d.player?.data?.itemLevel;
    const sets = [];
    const seen = new Set();
    for (const it of gear) if (it.set?.display && !seen.has(it.set.name)) { seen.add(it.set.name); sets.push(it.set); }

    const mid = h('div.doll-mid',
      d.render ? h('img.doll-render', { src: d.render, alt: '', referrerpolicy: 'no-referrer' }) : null,
      ilvl != null ? h('div.doll-ilvl', h('b', String(ilvl)), h('span', 'item level')) : null);
    const img = mid.querySelector('img');
    img?.addEventListener('error', () => img.remove());

    return [
      h('div.doll',
        h('div.doll-col.left', ...LEFT.map((s) => slotEl(s, bySlot))),
        mid,
        h('div.doll-col.right', ...RIGHT.map((s) => slotEl(s, bySlot))),
        h('div.doll-bottom', ...BOTTOM.map((s) => slotEl(s, bySlot)))),
      sets.length ? h('div.cp-sets', ...sets.map((s) => h('span.cp-set', s.display))) : null,
      h('p.cp-hint', window.matchMedia('(hover: hover)').matches ? 'Hover an item for its tooltip.' : 'Tap an item for its tooltip.'),
    ].filter(Boolean);
  }

  // --- item tooltip ------------------------------------------------------------------

  const tipEl = () => $('item-tip');
  let tipPinned = false;
  let tipSlot = null;

  function coins(s) {
    const parts = [];
    if (s.g) parts.push(h('span.coin.g', `${s.g}`));
    if (s.s) parts.push(h('span.coin.s', `${s.s}`));
    if (s.c || !parts.length) parts.push(h('span.coin.c', `${s.c}`));
    return parts;
  }

  function tooltip(it) {
    const rows = [];
    const line = (cls, ...kids) => rows.push(h(`div.${cls}`, ...kids));
    const pair = (l, r) => rows.push(h('div.it-row', h('span', l || ''), h('span', r || '')));
    line(`it-name.q-${it.quality}`, it.name);
    if (it.ilvlText) line('it-gold', it.ilvlText);
    if (it.binding) line('it-white', it.binding);
    if (it.unique) line('it-white', it.unique);
    if (it.type || it.subclass) pair(it.type, it.subclass);
    if (it.weapon) { pair(it.weapon.damage, it.weapon.speed); if (it.weapon.dps) line('it-white', it.weapon.dps); }
    if (it.armor) line('it-white', it.armor);
    for (const s of it.stats.filter((x) => !x.equip)) rows.push(h('div', { style: s.color ? { color: s.color } : null }, s.text));
    for (const e of it.enchants) line('it-green', e);
    for (const s of it.sockets) line('it-grey', s);
    if (it.durability) line('it-white', it.durability);
    if (it.reqClasses) line('it-white', it.reqClasses);
    if (it.reqLevel) line('it-white', it.reqLevel);
    for (const s of it.stats.filter((x) => x.equip)) rows.push(h('div.it-green', s.text));
    for (const s of it.spells) rows.push(h('div', { class: s.color ? null : 'it-green', style: s.color ? { color: s.color } : null }, s.text));
    if (it.set) {
      rows.push(h('div.it-gap'));
      line('it-gold', it.set.display || it.set.name);
      for (const p of it.set.items) rows.push(h(`div.it-indent.${p.equipped ? 'it-setitem' : 'it-grey'}`, p.name));
      rows.push(h('div.it-gap'));
      for (const f of it.set.effects) rows.push(h(`div.${f.active ? 'it-green' : 'it-grey'}`, f.text));
    }
    if (it.description) line('it-desc', `“${it.description}”`);
    if (it.sell && (it.sell.g || it.sell.s || it.sell.c)) rows.push(h('div.it-white.it-sell', 'Sell Price: ', ...coins(it.sell)));
    return rows;
  }

  function showTip(slotBtn, sheet) {
    let content = null;
    if (slotBtn.dataset.node) {
      const t = talentNodes.get(slotBtn.dataset.node);
      if (t) content = talentTooltip(t);
    } else {
      const it = (data?.gear || []).find((i) => i.slot === slotBtn.dataset.slot);
      if (it) content = tooltip(it);
    }
    if (!content) return;
    const tip = tipEl();
    tip.replaceChildren(...content);
    tip.className = `item-tip${sheet ? ' sheet' : ''}`;
    tip.hidden = false;
    tipSlot = slotBtn;
    if (sheet) { tip.style.left = ''; tip.style.top = ''; return; }
    // Anchor to the icon + name, not the whole button (it spans the column).
    const parts = [...slotBtn.children].map((el) => el.getBoundingClientRect());
    const r = { left: Math.min(...parts.map((p) => p.left)), right: Math.max(...parts.map((p) => p.right)), top: Math.min(...parts.map((p) => p.top)) };
    const t = tip.getBoundingClientRect();
    const right = r.right + 12;
    const left = right + t.width <= window.innerWidth - 8 ? right : Math.max(8, r.left - t.width - 12);
    const top = Math.min(window.innerHeight - t.height - 8, Math.max(8, r.top));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTip(force) {
    if (!overlay) return;
    if (tipPinned && !force) return;
    tipPinned = false;
    tipSlot = null;
    tipEl().hidden = true;
  }

  const TIP_TARGETS = '.slot[data-slot], .tt-node[data-node]';
  function wireTips() {
    const panel = overlay.querySelector('.cp-panel');
    let lastPointer = 'mouse';
    panel.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; });
    panel.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse' || tipPinned) return;
      const slot = e.target.closest(TIP_TARGETS);
      if (slot) showTip(slot, false); else hideTip();
    });
    panel.addEventListener('pointerleave', () => hideTip());
    panel.addEventListener('focusin', (e) => {
      const slot = e.target.closest(TIP_TARGETS);
      if (slot && lastPointer === 'mouse' && !tipPinned) showTip(slot, false);
    });
    panel.addEventListener('focusout', () => { if (!tipPinned) hideTip(); });
    panel.addEventListener('click', (e) => {
      const slot = e.target.closest(TIP_TARGETS);
      if (!slot) { if (tipPinned && !e.target.closest('.item-tip')) hideTip(true); return; }
      if (lastPointer === 'mouse') return; // hover already shows it
      if (tipPinned && tipSlot === slot) { hideTip(true); return; }
      tipPinned = true;
      showTip(slot, true);
    });
    tipEl().addEventListener('click', () => { if (tipPinned) hideTip(true); });
    panel.querySelector('.cp-body').addEventListener('scroll', () => { if (!tipPinned) hideTip(); }, { passive: true });
  }

  // --- character sheet ---------------------------------------------------------------

  function statCard(title, rows) {
    const kept = rows.filter(Boolean);
    if (!kept.length) return null;
    return h('section.cp-card',
      h('h3', title),
      h('dl.cp-dl', ...kept.flatMap(([k, v, tip]) => [h('dt', { title: tip || null }, k), h('dd', v)])));
  }

  function base(p) {
    if (!p || p.eff == null) return '—';
    const bonus = p.base ? p.eff - p.base : 0;
    return h('span', fmt(p.eff), bonus > 0 ? h('small.cp-bonus', ` (${fmt(p.base)} +${fmt(bonus)})`) : null);
  }

  function weaponRows(w, prefix = '') {
    if (!w || w.min == null) return [];
    const label = (s) => (prefix ? `${prefix} ${s.replace(/^[A-Z][a-z]/, (c) => c.toLowerCase())}` : s);
    return [
      [label('Damage'), `${fmt(w.min)} – ${fmt(w.max)}`],
      w.speed ? [label('Speed'), fmt(w.speed, 2)] : null,
      w.dps ? [prefix ? `${prefix} DPS` : 'DPS', fmt(w.dps, 1)] : null,
    ];
  }

  function renderStats(d) {
    const s = d.sheet;
    if (!s) return empty('Blizzard sent no character sheet for this character.');
    const gear = Object.fromEntries((d.gear || []).map((i) => [i.slot, i]));
    const hasOff = Boolean(gear.OFF_HAND?.weapon);
    const hasRanged = Boolean(gear.RANGED?.weapon);
    const usesMana = s.powerType === 'Mana';
    const hasSpell = usesMana || (s.spellPower || 0) > 0 || (s.spellHealing || 0) > 0;
    const resist = Object.entries(s.resist || {});

    return [
      h('div.cp-vitals',
        h('div.cp-vital.hp', h('span', 'Health'), h('b', fmt(s.health))),
        s.power != null ? h(`div.cp-vital.${(s.powerType || 'power').toLowerCase()}`, h('span', s.powerType || 'Power'), h('b', fmt(s.power))) : null),
      h('div.cp-cards',
        statCard('Attributes', [
          ['Strength', base(s.strength)], ['Agility', base(s.agility)], ['Stamina', base(s.stamina)],
          ['Intellect', base(s.intellect)], ['Spirit', base(s.spirit)],
        ]),
        statCard('Melee', [
          ...weaponRows(s.mainHand, hasOff ? 'Main hand' : ''),
          ...(hasOff ? weaponRows(s.offHand, 'Off hand') : []),
          ['Attack power', fmt(s.attackPower)],
          ['Crit chance', pct(s.meleeCrit)],
          s.meleeHit ? ['Hit chance', pct(s.meleeHit)] : null,
        ]),
        hasRanged ? statCard('Ranged', [
          ...weaponRows(s.ranged),
          ['Attack power', fmt(s.rangedAttackPower)],
          ['Crit chance', pct(s.rangedCrit)],
          s.rangedHit ? ['Hit chance', pct(s.rangedHit)] : null,
        ]) : null,
        hasSpell ? statCard('Spell', [
          ['Spell power', fmt(s.spellPower)],
          ['Healing', fmt(s.spellHealing)],
          ['Crit chance', pct(s.spellCrit)],
          s.spellHit ? ['Hit chance', pct(s.spellHit)] : null,
          s.spellPenetration ? ['Penetration', fmt(s.spellPenetration)] : null,
          usesMana && s.manaRegen != null ? ['Mana regen', h('span', fmt(s.manaRegen), h('small.cp-bonus', ` · ${fmt(s.manaRegenCombat)} while casting`)), 'Mana per 5 seconds'] : null,
        ]) : null,
        statCard('Defense', [
          ['Armor', base(s.armor)],
          s.defense ? ['Defense', base(s.defense)] : null,
          ['Dodge', pct(s.dodge)],
          s.parry ? ['Parry', pct(s.parry)] : null,
          s.block ? ['Block', pct(s.block)] : null,
        ]),
        resist.length ? statCard('Resistances', resist.map(([k, v]) => [h(`span.res.res-${k}`, k.charAt(0).toUpperCase() + k.slice(1)), base(v)])) : null),
    ];
  }

  // --- talents -------------------------------------------------------------------------

  // In-game style trees from the class's talent layout; a plain list if the layout couldn't be loaded.
  const CELL = 56; // grid step in px (40px icon + gap)
  let talentNodes = new Map(); // "spec:node" -> { node, rank, tree }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function renderTalents(d) {
    const layout = d.talentLayout;
    if (!layout?.length) return renderTalentList(d);
    const learned = new Map();
    for (const tree of d.talents?.trees || []) {
      for (const t of tree.talents) {
        if (t.id) learned.set(`id:${t.id}`, t.rank || 0);
        if (t.name) learned.set(`name:${t.name}`, t.rank || 0);
      }
    }
    const rankOf = (n) => learned.get(`id:${n.talentId}`) ?? learned.get(`name:${n.name}`) ?? 0;
    talentNodes = new Map();

    const trees = layout.map((tree) => {
      const nodes = tree.nodes.map((n) => ({ ...n, rank: Math.min(rankOf(n), n.max) }));
      const points = nodes.reduce((s, n) => s + n.rank, 0);
      return { ...tree, nodes, points };
    });
    const total = trees.reduce((s, t) => s + t.points, 0);

    const summary = h('p.cp-summary',
      ...trees.flatMap((t, i) => [i ? h('span.muted', ' / ') : null, h(t.points ? 'b' : 'span.muted', `${t.name} ${t.points}`)]).filter(Boolean),
      h('span.muted', ` · ${total} point${total === 1 ? '' : 's'}`));

    const all = trees.flatMap((t) => t.nodes);
    const topY = hasRaw(all) ? Math.min(...all.map((n) => n.y)) : null;
    return [summary, h('div.tt-trees', ...trees.map((t) => treeEl(t, topY)))];
  }

  // Grid positions. Blizzard's canvas coordinates (600 units per cell) are used when every node has
  // them: display_row/col are off for some classes. Rows are measured from the class's top row
  // (topY) so a tree whose first row is empty still lines up with the others.
  const UNIT = 600;
  const hasRaw = (nodes) => nodes.length && nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));

  function treeEl(tree, topY) {
    let cols; let rows; let pos;
    if (hasRaw(tree.nodes) && Number.isFinite(topY)) {
      const minX = Math.min(...tree.nodes.map((n) => n.x));
      cols = Math.max(4, Math.round((Math.max(...tree.nodes.map((n) => n.x)) - minX) / UNIT) + 1);
      rows = Math.max(7, Math.round((Math.max(...tree.nodes.map((n) => n.y)) - topY) / UNIT) + 1);
      pos = (n) => ({ x: ((n.x - minX) / UNIT) * CELL + CELL / 2, y: ((n.y - topY) / UNIT) * CELL + CELL / 2 });
    } else {
      const minCol = Math.min(...tree.nodes.map((n) => n.col));
      cols = Math.max(4, Math.max(...tree.nodes.map((n) => n.col)) - minCol + 1);
      rows = Math.max(7, ...tree.nodes.map((n) => n.row));
      pos = (n) => ({ x: (n.col - minCol) * CELL + CELL / 2, y: (n.row - 1) * CELL + CELL / 2 });
    }
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));

    // Prerequisite arrows, and dashed links between "pick one" talents that lock each other.
    const svg = svgEl('svg', { class: 'tt-links', width: cols * CELL, height: rows * CELL, 'aria-hidden': 'true' });
    const defs = svgEl('defs', {});
    const marker = svgEl('marker', { id: `tt-arrow-${tree.specId}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }));
    defs.append(marker);
    svg.append(defs);
    for (const n of tree.nodes) {
      for (const targetId of n.unlocks) {
        const t = byId.get(targetId);
        if (!t) continue;
        const mutual = t.unlocks.includes(n.id);
        if (mutual && n.id > t.id) continue; // draw each pair once
        const a = pos(n);
        const b = pos(t);
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const pad = 23; // stop at the icon edge
        const [ux, uy] = [(b.x - a.x) / len, (b.y - a.y) / len];
        const line = svgEl('line', {
          x1: a.x + ux * pad, y1: a.y + uy * pad, x2: b.x - ux * pad, y2: b.y - uy * pad,
          class: `tt-link${mutual ? ' choice' : ''}${n.rank >= n.max || (mutual && (n.rank || t.rank)) ? ' met' : ''}`,
        });
        if (!mutual) line.setAttribute('marker-end', `url(#tt-arrow-${tree.specId})`);
        svg.append(line);
      }
    }

    const grid = h('div.tt-grid', { style: { width: `${cols * CELL}px`, height: `${rows * CELL}px` } }, svg,
      ...tree.nodes.map((n) => {
        const key = `${tree.specId}:${n.id}`;
        talentNodes.set(key, { node: n, tree });
        const { x, y } = pos(n);
        const state = n.rank >= n.max ? 'max' : n.rank > 0 ? 'some' : 'none';
        const btn = h(`button.tt-node.${state}`, {
          type: 'button', dataset: { node: key }, style: { left: `${x - 20}px`, top: `${y - 20}px` },
          'aria-label': `${n.name}, rank ${n.rank} of ${n.max}`,
        },
        n.icon ? h('img', { src: n.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span.tt-noicon', n.name.charAt(0)),
        h('span.tt-rank', `${n.rank}/${n.max}`));
        return btn;
      }));

    return h('section.tt-tree',
      h('h3', tree.name, h('span.cp-count', String(tree.points))),
      h('div.tt-scroll', grid));
  }

  function talentTooltip({ node: n, tree }) {
    const rows = [];
    rows.push(h('div.it-name', { style: { '--q': '#fff' } }, n.name));
    rows.push(h('div.it-white', `Rank ${n.rank}/${n.max}`));
    if (n.cast && n.cast !== 'Passive') {
      if (n.cost || n.range) rows.push(h('div.it-row', h('span', n.cost || ''), h('span', n.range || '')));
      rows.push(h('div.it-row', h('span', n.cast || ''), h('span', n.cooldown || '')));
    }
    const cur = n.ranks[Math.max(0, n.rank - 1)];
    if (cur) rows.push(h('div.it-gold.it-pre', cur));
    if (n.rank > 0 && n.rank < n.max && n.ranks[n.rank]) {
      rows.push(h('div.it-gap'));
      rows.push(h('div.it-white', 'Next rank:'));
      rows.push(h('div.it-gold.it-pre', n.ranks[n.rank]));
    }
    const nameOf = (id) => tree.nodes.find((x) => x.id === id)?.name;
    const choice = n.lockedBy.filter((id) => n.unlocks.includes(id)).map(nameOf).filter(Boolean);
    const prereq = n.lockedBy.filter((id) => !n.unlocks.includes(id)).map(nameOf).filter(Boolean);
    if (choice.length) rows.push(h('div.it-grey', `Can't be taken together with ${choice.join(', ')}`));
    if (prereq.length && !n.rank) rows.push(h('div.it-red', `Requires ${prereq.join(', ')}`));
    return rows;
  }

  function renderTalentList(d) {
    const t = d.talents;
    const trees = (t?.trees || []).slice().sort((a, b) => b.points - a.points);
    const total = trees.reduce((n, x) => n + x.points, 0);
    if (!total) return empty('No talent points spent yet.');
    return [
      h('p.cp-summary', ...trees.flatMap((x, i) => [i ? ' / ' : null, h('b', x.name), ` ${x.points}`]).filter(Boolean),
        h('span.muted', ` · ${total} point${total === 1 ? '' : 's'}`)),
      h('div.cp-cards',
        ...trees.map((x) => h('section.cp-card',
          h('h3', x.name, h('span.cp-count', String(x.points))),
          h('ul.cp-talents', ...x.talents.map((tl) => h('li',
            h('div.cp-talent', h('span', tl.name), tl.rank ? h('span.cp-rank', `Rank ${tl.rank}`) : null),
            tl.desc ? h('p', tl.desc) : null)))))),
      t.groups > 1 ? h('p.cp-hint', 'Showing the active talent set.') : null,
    ].filter(Boolean);
  }

  // --- professions -----------------------------------------------------------------------

  function profCard(p) {
    const pctFill = p.max ? Math.min(100, (p.skill / p.max) * 100) : 0;
    return h('section.cp-card.cp-prof',
      h('div.cp-prof-head', h('h3', p.name), h('span.cp-skill', h('b', fmt(p.skill)), ` / ${fmt(p.max)}`)),
      h('div.cp-bar', h('span', { style: { width: `${pctFill}%` } })),
      p.recipes.length ? h('details.cp-recipes',
        h('summary', `${p.recipes.length} recipe${p.recipes.length === 1 ? '' : 's'} known`),
        h('ul', ...p.recipes.map((r) => h('li', r)))) : null);
  }

  function renderProfessions(d) {
    const p = d.professions;
    if (!p || (!p.primary.length && !p.secondary.length)) return empty('No professions learned yet.');
    return [
      p.primary.length ? h('div.cp-cards', ...p.primary.map(profCard)) : empty('No primary professions yet.'),
      p.secondary.length ? h('h3.cp-sub', 'Secondary skills') : null,
      p.secondary.length ? h('div.cp-cards', ...p.secondary.map(profCard)) : null,
    ].filter(Boolean);
  }

  // --- reputation ----------------------------------------------------------------------------

  function renderReputation(d) {
    const reps = d.reputations || [];
    if (!reps.length) return empty('No reputations yet.');
    return h('ul.cp-reps', ...reps.map((r) => {
      const fill = r.max ? Math.min(100, ((r.value || 0) / r.max) * 100) : 100;
      return h(`li.rep-t${Math.max(0, Math.min(7, r.tier ?? 3))}`,
        h('span.rep-name', r.name),
        h('span.rep-standing', r.standing || ''),
        h('span.cp-bar.rep-bar', h('span', { style: { width: `${fill}%` } })),
        h('span.rep-value', r.max ? `${fmt(r.value)} / ${fmt(r.max)}` : ''));
    }));
  }

  // --- fun facts -------------------------------------------------------------------------------

  const HIGHLIGHTS = [
    [60, 'Deaths'], [114, 'Deaths from falling'], [107, 'Creatures killed'], [1487, 'Killing blows'],
    [98, 'Quests completed'], [94, 'Quests abandoned'], [932, 'Dungeons entered'], [918, 'Dungeon deaths'],
    [349, 'Flight paths taken'], [353, 'Times hearthed'], [346, 'Drinks'], [347, 'Food eaten'],
    [345, 'Health potions'], [922, 'Mana potions'], [1044, 'Need rolls'], [1043, 'Greed rolls'],
    [588, 'Honorable kills'], [64222, 'Times camped'], [1518, 'Fish caught'],
  ];

  function renderFun(d) {
    const fun = d.fun || [];
    const ach = d.achievements;
    if (!fun.length && !ach?.recent?.length) return empty('No statistics yet.');
    const byId = new Map(fun.map((s) => [s.id, s]));
    const tiles = HIGHLIGHTS.filter(([id]) => byId.has(id)).map(([id, label]) => h('div.cp-tile', h('b', fmt(byId.get(id).qty)), h('span', label)));
    const prey = byId.get(1336);
    if (prey?.desc) tiles.push(h('div.cp-tile', h('b', prey.desc), h('span', `Most killed type (${fmt(prey.qty)})`)));

    const bosses = fun.filter((s) => /boss kills/i.test(s.cat)).sort((a, b) => (b.qty || 0) - (a.qty || 0));
    const cats = new Map();
    for (const s of fun) {
      if (!cats.has(s.cat)) cats.set(s.cat, []);
      cats.get(s.cat).push(s);
    }

    return [
      tiles.length ? h('div.cp-tiles', ...tiles) : null,
      h('div.cp-cards',
        bosses.length ? h('section.cp-card',
          h('h3', 'Boss kills'),
          h('ul.cp-list', ...bosses.map((b) => h('li', h('span', b.name.replace(/ kills \(/i, ' (')), h('b', fmt(b.qty)))))) : null,
        ach?.recent?.length ? h('section.cp-card',
          h('h3', 'Recent achievements'),
          h('ul.cp-list', ...ach.recent.map((a) => h('li', h('span', a.name), h('time', { title: fullDate(a.at) }, ago(a.at)))))) : null),
      cats.size ? h('details.cp-all',
        h('summary', 'All statistics'),
        ...[...cats].map(([cat, list]) => h('section',
          h('h4', cat),
          h('ul.cp-list', ...list.map((s) => h('li', h('span', s.name), h('b', s.desc ? `${s.desc} (${fmt(s.qty)})` : fmt(s.qty)))))))) : null,
    ].filter(Boolean);
  }

  // --- start -----------------------------------------------------------------------------------

  const initial = slugFromHash();
  if (initial) { pushed = false; open(initial); }
})();
