/* Gece Okuru — açılır pencere */
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
  const MODE_DOTS = { off: 'transparent', dark: '#141a33', light: '#fbfaf6', sepia: '#e9d9b6', custom: null };

  let tab = null;
  let host = '';
  let web = false;
  let data = null;
  let scopeTouched = false; // kullanıcı "Sadece bu site"yi elle değiştirdi mi

  function isWebUrl(url) { return typeof url === 'string' && /^https?:\/\//i.test(url); }

  function siteScope() { return web && host && $('siteScope').checked; }

  async function write(patch) {
    if (siteScope()) await GO.saveSite(host, patch);
    else await GO.saveSettings(patch);
  }

  function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* --- Arayüz oluşturma --- */
  function buildModes() {
    const wrap = $('modes');
    for (const m of GO.MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.mode = m;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = MODE_DOTS[m] || '#1b1d23';
      if (m === 'off') dot.style.borderStyle = 'dashed';
      b.append(dot, document.createTextNode(GO.MODE_LABELS[m]));
      b.addEventListener('click', () => selectMode(m));
      wrap.append(b);
    }
  }

  function buildSliders() {
    const wrap = $('sliders');
    for (const s of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'slider';
      const id = 'sl-' + s.key;
      row.innerHTML = `<label for="${id}">${s.label}</label><output id="${id}-out"></output>` +
        `<input type="range" id="${id}" min="${s.min}" max="${s.max}" step="1">`;
      wrap.append(row);
      const input = row.querySelector('input');
      const out = row.querySelector('output');
      const save = debounce((v) => write({ [s.key]: v }), 120);
      input.addEventListener('input', () => {
        out.textContent = input.value + s.unit;
        save(Number(input.value));
      });
    }
  }

  async function selectMode(m) {
    if (siteScope()) {
      await GO.saveSite(host, m === 'off' ? { mode: null, disabled: true } : { mode: m, disabled: null });
    } else {
      const patch = { mode: m };
      if (m !== 'off' && !data.settings.enabled) patch.enabled = true;
      await GO.saveSettings(patch);
    }
  }

  /* --- Durumdan arayüze --- */
  function render() {
    const s = data.settings;
    const site = (data.sites || {})[host] || {};
    const hasOverride = Object.keys(site).length > 0;
    const eff = host ? GO.effectiveFor(host, data) : null;
    const scoped = siteScope();
    const active = document.activeElement;

    $('enabled').checked = !!s.enabled;

    let shownMode = s.mode;
    if (scoped && eff) shownMode = site.disabled ? 'off' : (site.mode !== undefined ? site.mode : s.mode);
    for (const b of $('modes').children) b.setAttribute('aria-checked', String(b.dataset.mode === shownMode));
    const custom = $('modes').querySelector('[data-mode="custom"] .dot');
    if (custom) custom.style.background = s.customBg;

    const src = scoped ? Object.assign({}, s, site) : s;
    for (const sl of SLIDERS) {
      const input = $('sl-' + sl.key);
      if (input !== active) input.value = src[sl.key];
      $('sl-' + sl.key + '-out').textContent = input.value + sl.unit;
    }

    // Durum satırı
    let st = '';
    if (!s.enabled) st = 'Eklenti tüm sitelerde kapalı.';
    else if (eff && web) {
      if (site.disabled) st = 'Bu sitede devre dışı.';
      else if (eff.scheduled && eff.mode === 'off') st = 'Zamanlama nedeniyle şu an uygulanmıyor.';
      else st = 'Bu sitede: ' + GO.MODE_LABELS[eff.mode] + (hasOverride ? ' (siteye özel)' : ' (genel)');
    } else st = scoped ? '' : 'Genel ayar düzenleniyor.';
    $('status').textContent = st;

    $('siteDisabled').checked = !!site.disabled;
    $('resetSite').hidden = !(web && hasOverride);

    const sc = s.schedule;
    if ($('schedType') !== active) $('schedType').value = sc.type;
    $('schedInfo').textContent =
      sc.type === 'time' ? `Her gün ${sc.start} – ${sc.end} arası uygulanır.` :
      sc.type === 'system' ? 'Sistem karanlık temadayken uygulanır.' :
      'Tema her zaman uygulanır.';
  }

  async function refresh() {
    data = await GO.getAll();
    if (!scopeTouched && web && host) {
      const site = data.sites[host] || {};
      $('siteScope').checked = Object.keys(site).some((k) => k !== 'disabled');
    }
    render();
  }

  /* --- Okuma modu --- */
  async function toggleReader() {
    if (!tab || !web) return;
    const msg = { type: GO.MSG.TOGGLE_READER };
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['shared/common.js', 'content/theme.js', 'content/reader.js']
        });
        await chrome.tabs.sendMessage(tab.id, msg);
      } catch (e2) {
        $('status').textContent = 'Okuma modu bu sayfada açılamadı.';
        return;
      }
    }
    window.close();
  }

  /* --- Başlat --- */
  async function init() {
    buildModes();
    buildSliders();

    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { tab = null; }
    web = !!(tab && isWebUrl(tab.url));
    host = web ? GO.hostOf(tab.url) : '';
    $('host').textContent = host || 'Tarayıcı sayfası';
    $('restricted').hidden = web;
    $('reader').disabled = !web;
    $('siteScopeWrap').hidden = !web;
    $('disableWrap').hidden = !web;

    $('enabled').addEventListener('change', (e) => GO.saveSettings({ enabled: e.target.checked }));
    $('siteScope').addEventListener('change', () => { scopeTouched = true; render(); });
    $('siteDisabled').addEventListener('change', (e) => GO.saveSite(host, { disabled: e.target.checked ? true : null }));
    $('resetSite').addEventListener('click', async (e) => {
      e.preventDefault();
      await GO.clearSite(host);
      scopeTouched = true;
      $('siteScope').checked = false;
    });
    $('schedType').addEventListener('change', (e) => GO.saveSettings({ schedule: { type: e.target.value } }));
    $('reader').addEventListener('click', toggleReader);
    $('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && (changes.settings || changes.sites)) refresh();
    });

    await refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
