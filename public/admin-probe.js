'use strict';

/* Admin "API probe": raw Blizzard responses for one character, to download and inspect. */
(() => {
  const { h, api } = window.WF;
  const $ = (id) => document.getElementById(id);
  let result = null;
  let regionByName = new Map();

  const kb = (obj) => {
    const n = obj === undefined ? 0 : new Blob([JSON.stringify(obj)]).size;
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
  };
  const okStatus = (s) => s === 200;

  async function start() {
    const sel = $('probe-region');
    if (!sel.options.length) {
      const site = await api('/api/site').catch(() => ({ regions: ['us', 'eu', 'kr', 'tw'], defaultRegion: 'us' }));
      sel.replaceChildren(...site.regions.map((r) => h('option', { value: r, selected: r === site.defaultRegion }, r.toUpperCase())));
    }
    try {
      const { players } = await api('/api/admin/players');
      regionByName = new Map();
      const opts = players.filter((p) => p.hasProfile).map((p) => {
        const name = `${p.firstName} ${p.surname}`.trim();
        regionByName.set(name.toLowerCase(), p.region);
        return h('option', { value: name }, `${p.data?.level ? `Level ${p.data.level} ` : ''}${p.data?.className || ''}`.trim() || null);
      });
      $('probe-names').replaceChildren(...opts);
    } catch { /* the probe still works with a typed name */ }
  }

  $('probe-name').addEventListener('change', () => {
    const r = regionByName.get($('probe-name').value.trim().toLowerCase());
    if (r) $('probe-region').value = r;
  });

  $('probe-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('probe-go');
    btn.disabled = true;
    $('probe-msg').textContent = 'Probing… (takes a few seconds)';
    try {
      result = await api('/api/admin/probe', { method: 'POST', body: { slug: $('probe-name').value, region: $('probe-region').value, mode: $('probe-mode').value } });
      const s = Object.values(result.summary);
      $('probe-msg').textContent = `${s.filter(okStatus).length} of ${s.length} calls returned data in ${(result.tookMs / 1000).toFixed(1)} s${result.rateLimited ? ' · stopped early: rate limited' : ''}.`;
      render();
    } catch (err) {
      $('probe-msg').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function iconFor(key) {
    const m = /^item\/(\d+)$/.exec(key);
    if (!m) return null;
    const assets = result.results[`item-media/${m[1]}`]?.data?.assets;
    const icon = Array.isArray(assets) && assets.find((a) => a.key === 'icon' && /^https:\/\//.test(a.value));
    return icon ? h('img.probe-icon', { src: icon.value, alt: '', loading: 'lazy' }) : null;
  }

  function render() {
    $('probe-out').hidden = false;
    const rows = [];
    for (const [key, r] of Object.entries(result.results)) {
      const name = key.startsWith('item/') && typeof r.data?.name === 'string' ? `${key} · ${r.data.name}` : key;
      const viewBtn = r.data ? h('button.btn.small.ghost', { type: 'button' }, 'View') : null;
      const tr = h('tr', { class: okStatus(r.status) ? null : 'probe-miss' },
        h('td', h('span.probe-key', iconFor(key), name)),
        h('td.num', String(r.status)),
        h('td.num', r.data ? kb(r.data) : '—'),
        h('td.muted', r.error || ''),
        h('td', viewBtn));
      rows.push(tr);
      if (viewBtn) {
        let detail = null;
        viewBtn.addEventListener('click', () => {
          if (!detail) {
            detail = h('tr.probe-detail', h('td', { colSpan: 5 }, h('pre.probe-json', JSON.stringify(r.data, null, 2))));
            tr.after(detail);
          } else detail.hidden = !detail.hidden;
          viewBtn.textContent = detail.hidden ? 'View' : 'Hide';
        });
      }
    }
    $('probe-table').replaceChildren(
      h('thead', h('tr', h('th', 'Endpoint'), h('th.num', 'Status'), h('th.num', 'Size'), h('th', 'Error'), h('th'))),
      h('tbody', ...rows));
  }

  $('probe-download').addEventListener('click', () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `probe-${result.slug}-${result.region}${result.mode === 'talents' ? '-talents' : ''}-${new Date(result.probedAt).toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });

  $('probe-copy').addEventListener('click', async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      $('probe-msg').textContent = 'Copied. It can be large; the downloaded file is easier to send.';
    } catch {
      $('probe-msg').textContent = 'Copy failed; use Download instead.';
    }
  });

  window.AdminProbe = { start };
})();
