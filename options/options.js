/* Gece Okuru — ayarlar sayfası */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const SLIDERS = [
    { key: 'brightness', label: 'Parlaklık', min: 50, max: 150, unit: '%' },
    { key: 'contrast', label: 'Kontrast', min: 50, max: 150, unit: '%' },
    { key: 'grayscale', label: 'Gri tonlama', min: 0, max: 100, unit: '%' },
    { key: 'warmth', label: 'Mavi ışık filtresi', min: 0, max: 100, unit: '%' },
    { key: 'dim', label: 'Karartma', min: 0, max: 80, unit: '%' },
    { key: 'fontScale', label: 'Yazı boyutu', min: 80, max: 150, unit: '%' }
  ];
  const READER = [
    { key: 'size', unit: 'px', num: true },
    { key: 'width', unit: 'px', num: true },
    { key: 'lineHeight', unit: '', num: true, fixed: 1 },
    { key: 'ttsRate', unit: '×', num: true, fixed: 1 }
  ];

  let data = null;
  let toastTimer = null;

  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg || 'Kaydedildi';
    t.classList.toggle('err', !!err);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  async function save(patch) {
    try { await GO.saveSettings(patch); toast(); } catch (e) { toast('Kaydedilemedi: ' + e.message, true); }
  }
  const saveSoon = debounce(save, 150);

  function fmt(v, d) { return d.fixed ? Number(v).toFixed(d.fixed) : String(v); }

  /* --- Oluştur --- */
  function build() {
    const modes = $('modes');
    for (const m of GO.MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.mode = m;
      b.textContent = GO.MODE_LABELS[m];
      b.addEventListener('click', () => save({ mode: m }));
      modes.append(b);
    }

    const sl = $('sliders');
    for (const s of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'slider';
      row.innerHTML = `<label for="sl-${s.key}">${s.label}</label><output id="sl-${s.key}-out"></output>` +
        `<input type="range" id="sl-${s.key}" min="${s.min}" max="${s.max}" step="1">`;
      sl.append(row);
      const input = row.querySelector('input');
      input.addEventListener('input', () => {
        row.querySelector('output').textContent = input.value + s.unit;
        saveSoon({ [s.key]: Number(input.value) });
      });
    }

    $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
    $('fontFamily').addEventListener('change', (e) => save({ fontFamily: e.target.value }));

    $('lhOn').addEventListener('change', (e) => {
      $('lineHeight').disabled = !e.target.checked;
      save({ lineHeight: e.target.checked ? Number($('lineHeight').value) || 1.6 : 0 });
    });
    $('lineHeight').addEventListener('input', (e) => {
      $('lineHeight-out').textContent = Number(e.target.value).toFixed(1);
      saveSoon({ lineHeight: Number(e.target.value) });
    });

    for (const k of ['customBg', 'customText', 'customLink']) {
      $(k).addEventListener('input', (e) => { paintPreview(); saveSoon({ [k]: e.target.value }); });
    }

    for (const r of document.querySelectorAll('input[name="sched"]')) {
      r.addEventListener('change', () => { if (r.checked) { $('times').classList.toggle('off', r.value !== 'time'); save({ schedule: { type: r.value } }); } });
    }
    $('schedStart').addEventListener('change', (e) => save({ schedule: { start: e.target.value || '20:00' } }));
    $('schedEnd').addEventListener('change', (e) => save({ schedule: { end: e.target.value || '07:00' } }));

    $('r-theme').addEventListener('change', (e) => save({ reader: { theme: e.target.value } }));
    $('r-font').addEventListener('change', (e) => save({ reader: { font: e.target.value } }));
    for (const d of READER) {
      const input = $('r-' + d.key);
      input.addEventListener('input', () => {
        $('r-' + d.key + '-out').textContent = fmt(input.value, d) + d.unit;
        saveSoon({ reader: { [d.key]: Number(input.value) } });
      });
    }

    $('export').addEventListener('click', exportJSON);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', importJSON);
    $('reset').addEventListener('click', resetAll);
    $('shortcuts').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  function paintPreview() {
    const p = $('preview');
    p.style.background = $('customBg').value;
    p.style.color = $('customText').value;
    p.querySelector('a').style.color = $('customLink').value;
  }

  /* --- Doldur --- */
  function setIfIdle(el, v) { if (document.activeElement !== el) el.value = v; }

  function render() {
    const s = data.settings;
    $('enabled').checked = !!s.enabled;
    for (const b of $('modes').children) b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
    for (const d of SLIDERS) {
      const el = $('sl-' + d.key);
      setIfIdle(el, s[d.key]);
      $('sl-' + d.key + '-out').textContent = el.value + d.unit;
    }

    const ff = $('fontFamily');
    if (![...ff.options].some((o) => o.value === s.fontFamily)) {
      const o = document.createElement('option');
      o.value = s.fontFamily; o.textContent = s.fontFamily;
      ff.append(o);
    }
    ff.value = s.fontFamily;

    const lhOn = Number(s.lineHeight) > 0;
    $('lhOn').checked = lhOn;
    $('lineHeight').disabled = !lhOn;
    setIfIdle($('lineHeight'), lhOn ? s.lineHeight : 1.6);
    $('lineHeight-out').textContent = lhOn ? Number(s.lineHeight).toFixed(1) : 'kapalı';

    for (const k of ['customBg', 'customText', 'customLink']) setIfIdle($(k), s[k]);
    paintPreview();

    for (const r of document.querySelectorAll('input[name="sched"]')) r.checked = r.value === s.schedule.type;
    $('times').classList.toggle('off', s.schedule.type !== 'time');
    setIfIdle($('schedStart'), s.schedule.start);
    setIfIdle($('schedEnd'), s.schedule.end);

    $('r-theme').value = s.reader.theme;
    $('r-font').value = s.reader.font;
    for (const d of READER) {
      const el = $('r-' + d.key);
      setIfIdle(el, s.reader[d.key]);
      $('r-' + d.key + '-out').textContent = fmt(el.value, d) + d.unit;
    }

    renderSites();
  }

  function describeExtra(site) {
    const parts = [];
    if (site.disabled) parts.push('devre dışı');
    const names = { brightness: 'parlaklık', contrast: 'kontrast', grayscale: 'gri', warmth: 'mavi ışık', dim: 'karartma', fontScale: 'yazı', fontFamily: 'yazı tipi', lineHeight: 'satır aralığı' };
    for (const k of Object.keys(names)) if (site[k] !== undefined) parts.push(names[k] + (typeof site[k] === 'number' ? ' ' + site[k] : ''));
    return parts.join(', ') || '—';
  }

  function renderSites() {
    const tbody = $('siteRows');
    tbody.textContent = '';
    const hosts = Object.keys(data.sites || {}).sort();
    $('noSites').hidden = hosts.length > 0;
    tbody.parentElement.hidden = hosts.length === 0;
    for (const h of hosts) {
      const site = data.sites[h];
      const tr = document.createElement('tr');
      const tdHost = document.createElement('td'); tdHost.className = 'host'; tdHost.textContent = h;
      const tdMode = document.createElement('td');
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', h + ' modu');
      const inherit = document.createElement('option'); inherit.value = ''; inherit.textContent = 'Genel ayar';
      sel.append(inherit);
      for (const m of GO.MODES) {
        const o = document.createElement('option'); o.value = m; o.textContent = GO.MODE_LABELS[m]; sel.append(o);
      }
      sel.value = site.disabled ? 'off' : (site.mode || '');
      sel.addEventListener('change', async () => {
        const v = sel.value;
        const patch = v === '' ? { mode: null, disabled: null } : v === 'off' ? { mode: null, disabled: true } : { mode: v, disabled: null };
        await GO.saveSite(h, patch); toast();
      });
      tdMode.append(sel);
      const tdExtra = document.createElement('td'); tdExtra.className = 'extra'; tdExtra.textContent = describeExtra(site);
      const tdDel = document.createElement('td');
      const del = document.createElement('button'); del.type = 'button'; del.className = 'danger'; del.textContent = 'Sil';
      del.addEventListener('click', async () => { await GO.clearSite(h); toast('Silindi'); });
      tdDel.append(del);
      tr.append(tdHost, tdMode, tdExtra, tdDel);
      tbody.append(tr);
    }
  }

  /* --- Yedekleme --- */
  async function exportJSON() {
    const all = await GO.getAll();
    const payload = { app: 'gece-okuru', version: 1, exported: new Date().toISOString(), settings: all.settings, sites: all.sites };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gece-okuru-ayarlar-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Dışa aktarıldı');
  }

  async function importJSON(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (!obj || typeof obj !== 'object' || (typeof obj.settings !== 'object' && typeof obj.sites !== 'object')) throw new Error('Geçersiz dosya');
      const base = GO.clone(GO.DEFAULTS.settings);
      const inS = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
      const settings = {};
      for (const k of Object.keys(base)) if (inS[k] !== undefined && typeof inS[k] === typeof base[k]) settings[k] = inS[k];
      settings.schedule = Object.assign(base.schedule, typeof inS.schedule === 'object' ? inS.schedule : {});
      settings.reader = Object.assign(base.reader, typeof inS.reader === 'object' ? inS.reader : {});
      const sites = {};
      if (obj.sites && typeof obj.sites === 'object') {
        for (const [h, v] of Object.entries(obj.sites)) {
          if (!v || typeof v !== 'object') continue;
          const clean = {};
          for (const k of GO.SITE_KEYS) if (v[k] !== undefined) clean[k] = v[k];
          if (Object.keys(clean).length) sites[String(h)] = clean;
        }
      }
      await chrome.storage.sync.set({ settings: Object.assign(base, settings), sites });
      toast('İçe aktarıldı');
    } catch (err) {
      toast('İçe aktarılamadı: ' + err.message, true);
    }
  }

  async function resetAll() {
    if (!confirm('Tüm ayarlar ve siteye özel ayarlar silinecek. Emin misin?')) return;
    await chrome.storage.sync.set({ settings: GO.clone(GO.DEFAULTS.settings), sites: {} });
    toast('Varsayılanlara dönüldü');
  }

  async function refresh() { data = await GO.getAll(); render(); }

  document.addEventListener('DOMContentLoaded', async () => {
    build();
    chrome.storage.onChanged.addListener((c, area) => { if (area === 'sync' && (c.settings || c.sites)) refresh(); });
    await refresh();
  });
})();
