'use strict';

(() => {
  const { h, ago, countdown, fullDate, api, classColor, displayName, avatar } = window.WF;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  let regions = ['us', 'eu', 'kr', 'tw'];
  let statusTimer = null;
  let players = [];
  let guild = null;
  let listLimit = PAGE;

  function flash(id, text, kind = 'error') {
    const el = $(id);
    el.textContent = text || '';
    el.dataset.kind = kind;
  }

  const regionOptions = (selected) => regions.map((r) => h('option', { value: r, selected: r === selected }, r.toUpperCase()));

  async function init() {
    try {
      const site = await api('/api/site');
      regions = site.regions;
      $('region').replaceChildren(...regionOptions(site.defaultRegion));
      $('guild-region').replaceChildren(...regionOptions(site.defaultRegion));
    } catch { /* defaults */ }

    const me = await api('/api/admin/me').catch(() => ({ authenticated: false }));
    showAdmin(me.authenticated);
  }

  function showAdmin(on) {
    $('login-panel').hidden = on;
    $('admin-panel').hidden = !on;
    clearInterval(statusTimer);
    window.AdminVisits?.[on ? 'start' : 'stop']();
    if (on) window.AdminProbe?.start();
    if (on) {
      refresh();
      statusTimer = setInterval(refresh, 15_000);
    } else {
      $('password').focus();
    }
  }

  // Don't re-render a section while the admin is typing in it.
  const editing = (containerId) => document.activeElement && $(containerId).contains(document.activeElement)
    && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);

  async function refresh() {
    try {
      const [status, list, g] = await Promise.all([api('/api/admin/status'), api('/api/admin/players'), api('/api/admin/guild')]);
      renderStatus(status);
      players = list.players;
      guild = g.guild;
      if (!editing('guild-panel')) renderGuild();
      if (!editing('admin-list')) renderList();
    } catch (err) {
      if (err.status === 401) showAdmin(false);
      else flash('status-msg', err.message);
    }
  }

  function renderStatus(s) {
    const lp = s.lastPoll;
    const item = (label, value, kind) => h('div.status-item', h('span.label', label), h(`span.value${kind ? '.' + kind : ''}`, value));
    const pollText = lp
      ? `${ago(lp.finishedAt)} · ${lp.checked ?? lp.ok + lp.notFound + lp.errors} profiles (${lp.ok} ok, ${lp.notFound} not found, ${lp.errors} errors)`
      : 'Not yet';
    const err = lp?.error || lp?.guildError;
    $('status').replaceChildren(
      item('Blizzard credentials', s.credentialsConfigured ? 'Configured' : 'Missing in .env', s.credentialsConfigured ? 'good' : 'bad'),
      item('Last poll', pollText),
      item('Last poll error', err || 'None', err ? 'bad' : 'good'),
      item('Next poll', s.polling ? 'Running now…' : s.nextPollAt ? `in ${countdown(s.nextPollAt)}` : '—'),
      item('Intervals', `roster & added players ${fmtMin(s.pollIntervalSeconds)} · guild profiles ${fmtMin(s.guildProfileIntervalSeconds)}`),
      item('API quota this hour', s.quota?.allotted ? `${s.quota.current ?? '?'} / ${s.quota.allotted}` : 'Not reported'),
    );
  }

  const fmtMin = (sec) => `${Math.round((sec / 60) * 10) / 10} min`;

  // --- guild ---

  function renderGuild() {
    const g = guild;
    $('guild-submit').textContent = g ? 'Change guild' : 'Track guild';
    if (!g) {
      $('guild-info').replaceChildren();
      $('rank-editor').hidden = true;
      return;
    }
    const statusKind = g.status === 'ok' ? 'ok' : g.status === 'pending' ? 'pending' : 'error';
    const meta = [g.faction, g.ruleset, g.region.toUpperCase(), g.memberCount != null ? `${g.memberCount} members` : null].filter(Boolean).join(' · ');
    const removeBtn = h('button.btn.small.danger', { type: 'button' }, 'Stop tracking');
    let armed = false;
    removeBtn.addEventListener('click', async () => {
      if (!armed) {
        armed = true; removeBtn.textContent = 'Confirm: remove guild & its members?';
        setTimeout(() => { armed = false; removeBtn.textContent = 'Stop tracking'; }, 4000);
        return;
      }
      try {
        const r = await api('/api/admin/guild', { method: 'DELETE' });
        flash('guild-msg', `Stopped tracking. Removed ${r.removed} guild members (players you added by hand were kept).`, 'ok');
        refresh();
      } catch (err) { flash('guild-msg', err.message); }
    });

    $('guild-info').replaceChildren(h('div.guild-card',
      h('div',
        h('div.guild-title', `<${g.name}>`),
        h('div.admin-meta', meta),
        h('div.admin-meta',
          h(`span.pill.${statusKind}`, g.status === 'ok' ? 'Synced' : g.status === 'pending' ? 'Syncing…' : g.status === 'not_found' ? 'Not found' : 'Error'),
          h('span.muted', { title: fullDate(g.lastSyncAt) }, ` slug "${g.slug}" · last sync ${ago(g.lastSyncAt)}`)),
        g.statusMessage ? h('div.admin-err', g.statusMessage) : null,
      ),
      removeBtn,
    ));

    if (!$('guild-name').value) {
      $('guild-name').value = g.enteredName || g.name;
      $('guild-region').value = g.region;
    }

    $('rank-editor').hidden = !g.ranksSeen.length;
    $('rank-fields').replaceChildren(...g.ranksSeen.map((r) => h('label', `Rank ${r}`,
      h('input', { dataset: { rank: String(r) }, maxlength: 30, value: g.rankNames[r] || '', placeholder: r === 0 ? 'Guild Master' : `Rank ${r}` }))));
  }

  $('guild-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('guild-submit'); btn.disabled = true;
    flash('guild-msg', 'Looking up the guild…', 'ok');
    try {
      const r = await api('/api/admin/guild', {
        method: 'PUT',
        body: { name: $('guild-name').value, region: $('guild-region').value, slug: $('guild-slug').value },
      });
      guild = r.guild;
      $('guild-slug').value = '';
      flash('guild-msg', `Found <${r.guild.name}>. Syncing the roster now; members appear in a few seconds.`, 'ok');
      renderGuild();
      setTimeout(refresh, 3000);
      setTimeout(refresh, 10000);
    } catch (err) {
      flash('guild-msg', err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('save-ranks').addEventListener('click', async () => {
    const rankNames = {};
    for (const input of $('rank-fields').querySelectorAll('input')) {
      if (input.value.trim()) rankNames[input.dataset.rank] = input.value.trim();
    }
    try {
      const r = await api('/api/admin/guild/ranks', { method: 'PATCH', body: { rankNames } });
      guild = r.guild;
      flash('rank-msg', 'Saved.', 'ok');
      setTimeout(() => flash('rank-msg', ''), 3000);
    } catch (err) { flash('rank-msg', err.message); }
  });

  // --- players ---

  const STATUS_LABEL = { ok: 'OK', pending: 'Pending', not_found: 'Not found', stale: 'Stale', error: 'Error', roster: 'Roster' };

  function filtered() {
    const q = $('admin-search').value.trim().toLowerCase();
    const show = $('admin-show').value;
    return players.filter((p) => {
      if (q && !`${displayName(p)} ${p.nickname || ''}`.toLowerCase().includes(q)) return false;
      if (show === 'manual') return p.source !== 'guild';
      if (show === 'guild') return p.source === 'guild';
      if (show === 'hidden') return p.hidden;
      if (show === 'problems') return ['not_found', 'error', 'stale'].includes(p.status);
      return true;
    }).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }

  function renderList() {
    const hiddenCount = players.filter((p) => p.hidden).length;
    $('player-count').textContent = `(${players.length}${hiddenCount ? `, ${hiddenCount} hidden` : ''})`;
    if (!players.length) {
      $('admin-list').replaceChildren(h('p.muted', 'No players yet. Track a guild or add players above.'));
      $('admin-more').hidden = true;
      return;
    }
    const list = filtered();
    $('admin-list').replaceChildren(...(list.length ? list.slice(0, listLimit).map(adminRow) : [h('p.muted', 'No players match.')]));
    $('admin-more').hidden = list.length <= listLimit;
    $('admin-show-more').textContent = `Show more (${list.length - listLimit} left)`;
  }

  function adminRow(p) {
    const d = p.data || {};
    const color = classColor(d);
    const fromGuild = p.source === 'guild';
    const nickInput = h('input.nick-input', { value: p.nickname || '', maxlength: 32, placeholder: 'Nickname', 'aria-label': `Nickname for ${displayName(p)}` });
    nickInput.addEventListener('change', async () => {
      try { await api(`/api/admin/players/${p.id}`, { method: 'PATCH', body: { nickname: nickInput.value } }); p.nickname = nickInput.value.trim(); }
      catch (err) { alertInline(err.message); }
    });
    const noteInput = h('input.note-input', { value: p.note, maxlength: 80, placeholder: 'Note', 'aria-label': `Note for ${displayName(p)}` });

    noteInput.addEventListener('change', async () => {
      try { await api(`/api/admin/players/${p.id}`, { method: 'PATCH', body: { note: noteInput.value } }); p.note = noteInput.value.trim(); }
      catch (err) { alertInline(err.message); }
    });

    let regionCtl;
    if (fromGuild) {
      regionCtl = h('span.region-tag', p.region.toUpperCase());
    } else {
      regionCtl = h('select', { 'aria-label': 'Region' }, regionOptions(p.region));
      regionCtl.addEventListener('change', async () => {
        try { await api(`/api/admin/players/${p.id}`, { method: 'PATCH', body: { region: regionCtl.value } }); await doRefresh(p.id); }
        catch (err) { alertInline(err.message); }
      });
    }

    const refreshBtn = h('button.btn.small', { type: 'button', disabled: (d.level ?? 0) < 10 && fromGuild ? true : null, title: (d.level ?? 0) < 10 && fromGuild ? 'Profiles exist from level 10' : null }, 'Refresh');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = '…';
      await doRefresh(p.id);
    });

    let actionBtn;
    if (fromGuild) {
      // Guild members come back on the next sync if deleted, so hide instead.
      actionBtn = h('button.btn.small', { type: 'button' }, p.hidden ? 'Unhide' : 'Hide');
      actionBtn.addEventListener('click', async () => {
        try { await api(`/api/admin/players/${p.id}`, { method: 'PATCH', body: { hidden: !p.hidden } }); refresh(); }
        catch (err) { alertInline(err.message); }
      });
    } else {
      actionBtn = h('button.btn.small.danger', { type: 'button' }, 'Remove');
      let armed = false;
      actionBtn.addEventListener('click', async () => {
        if (!armed) {
          armed = true; actionBtn.textContent = 'Confirm?';
          setTimeout(() => { armed = false; actionBtn.textContent = 'Remove'; }, 3000);
          return;
        }
        try { await api(`/api/admin/players/${p.id}`, { method: 'DELETE' }); refresh(); }
        catch (err) { alertInline(err.message); }
      });
    }

    return h('div.admin-row', { dataset: { status: p.status, hidden: p.hidden ? '1' : '0' } },
      avatar(p, 'sm'),
      h('div.admin-main',
        h('span.char-name', { style: color ? { color } : null }, displayName(p)),
        h('span.admin-meta',
          h(`span.pill.${p.status}`, STATUS_LABEL[p.status] || p.status),
          ' ',
          h(`span.pill.src`, fromGuild ? (p.rankName || 'Guild') : 'Added'),
          p.hidden ? h('span.pill.hidden-pill', 'Hidden') : null,
          d.level != null ? ` Lvl ${d.level} ${d.raceName || ''} ${d.className || ''}` : '',
          h('span.muted', { title: fullDate(p.lastCheckedAt) }, p.lastCheckedAt ? ` · profile checked ${ago(p.lastCheckedAt)}` : ''),
        ),
        p.rawStatusMessage && p.status !== 'ok' ? h('span.admin-err', p.rawStatusMessage) : null,
      ),
      h('div.admin-controls', nickInput, noteInput, regionCtl, refreshBtn, actionBtn),
    );
  }

  async function doRefresh(id) {
    try { await api(`/api/admin/players/${id}/refresh`, { method: 'POST' }); }
    catch (err) { alertInline(err.message); }
    refresh();
  }

  function alertInline(text) { flash('status-msg', text); setTimeout(() => flash('status-msg', ''), 6000); }

  $('admin-search').addEventListener('input', () => { listLimit = PAGE; renderList(); });
  $('admin-show').addEventListener('change', () => { listLimit = PAGE; renderList(); });
  $('admin-show-more').addEventListener('click', () => { listLimit += PAGE; renderList(); });

  // --- forms ---

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    flash('login-msg', '');
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      showAdmin(true);
    } catch (err) {
      flash('login-msg', err.message);
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showAdmin(false);
  });

  $('refresh-all').addEventListener('click', async () => {
    try {
      await api('/api/admin/refresh-all', { method: 'POST' });
      flash('status-msg', 'Refresh started. Large guilds can take a minute or two.', 'ok');
      setTimeout(refresh, 3000);
    } catch (err) {
      flash('status-msg', err.message);
    }
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    flash('add-msg', 'Adding and checking Blizzard…', 'ok');
    try {
      const { player } = await api('/api/admin/players', {
        method: 'POST',
        body: { firstName: $('first').value, surname: $('last').value, region: $('region').value, note: $('note').value },
      });
      const found = player.status === 'ok';
      flash('add-msg', found ? `Added ${displayName(player)} (level ${player.data.level}).` : `Added ${displayName(player)}. ${player.rawStatusMessage || ''}`, found ? 'ok' : 'warn');
      $('first').value = ''; $('last').value = ''; $('note').value = '';
      $('first').focus();
      refresh();
    } catch (err) {
      flash('add-msg', err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $('bulk-add').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/players/bulk', { method: 'POST', body: { lines: $('bulk-lines').value } });
      const fails = r.failed.map((f) => `• ${f.line}: ${f.error}`).join('\n');
      flash('bulk-msg', `Added ${r.added}.${fails ? '\n' + fails : ''}`, r.failed.length ? 'warn' : 'ok');
      if (r.added) { $('bulk-lines').value = r.failed.map((f) => f.line).join('\n'); setTimeout(refresh, 2500); refresh(); }
    } catch (err) {
      flash('bulk-msg', err.message);
    }
  });

  $('bulk-nicks').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/nicknames', { method: 'POST', body: { lines: $('nick-lines').value } });
      const fails = r.failed.map((f) => `• ${f.line}: ${f.error}`).join('\n');
      flash('nick-msg', `Updated ${r.updated}.${fails ? '\n' + fails : ''}`, r.failed.length ? 'warn' : 'ok');
      $('nick-lines').value = r.failed.map((f) => f.line).join('\n');
      if (r.updated) refresh();
    } catch (err) {
      flash('nick-msg', err.message);
    }
  });

  init();
})();
