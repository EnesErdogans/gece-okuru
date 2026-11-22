/* Gece Okuru — ortak depolama ve yardımcılar.
 * Hem service worker (importScripts), hem content script, hem popup/options tarafından yüklenir.
 * globalThis.GO nesnesini tanımlar. */
(function () {
  if (globalThis.GO) return;

  const MODES = ['off', 'dark', 'light', 'sepia', 'custom'];
  const MODE_LABELS = { off: 'Kapalı', dark: 'Gece', light: 'Gündüz', sepia: 'Sepya', custom: 'Özel' };

  const DEFAULTS = {
    settings: {
      enabled: true,          // ana şalter (tüm siteler)
      mode: 'dark',           // off | dark | light | sepia | custom
      brightness: 100,        // 50-150 (%)
      contrast: 100,          // 50-150 (%)
      grayscale: 0,           // 0-100 (%)
      warmth: 0,              // 0-100 mavi ışık filtresi gücü
      dim: 0,                 // 0-80 ekran karartma (%)
      fontFamily: '',         // '' = değiştirme; ör. 'Georgia, serif'
      fontScale: 100,         // 80-150 (%)
      lineHeight: 0,          // 0 = değiştirme; aksi halde 1.2-2.2
      customBg: '#1b1d23',
      customText: '#e6e6e6',
      customLink: '#7fb4ff',
      schedule: { type: 'off', start: '20:00', end: '07:00' }, // off | time | system
      reader: { theme: 'auto', font: 'serif', size: 20, width: 720, lineHeight: 1.7, ttsRate: 1, ruler: false }
    },
    sites: {} // { 'ornek.com': { mode?, brightness?, ..., disabled?: true } }
  };

  // Site ayarında geçersiz kılınabilen anahtarlar
  const SITE_KEYS = ['mode', 'brightness', 'contrast', 'grayscale', 'warmth', 'dim', 'fontFamily', 'fontScale', 'lineHeight', 'disabled'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function hostOf(url) {
    try { const u = new URL(url); return u.hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  async function getAll() {
    const data = await chrome.storage.sync.get(['settings', 'sites']);
    const settings = Object.assign(clone(DEFAULTS.settings), data.settings || {});
    settings.schedule = Object.assign(clone(DEFAULTS.settings.schedule), (data.settings || {}).schedule || {});
    settings.reader = Object.assign(clone(DEFAULTS.settings.reader), (data.settings || {}).reader || {});
    return { settings, sites: data.sites || {} };
  }

  function parseHM(s) { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }

  // Zamanlama: gece mi? (system tipi için matchMedia gerekir; yoksa false)
  function isNightNow(schedule, now) {
    if (!schedule || schedule.type === 'off') return true; // zamanlama yoksa daima uygula
    if (schedule.type === 'system') {
      try { return globalThis.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; }
    }
    const d = now || new Date();
    const t = d.getHours() * 60 + d.getMinutes();
    const a = parseHM(schedule.start), b = parseHM(schedule.end);
    return a <= b ? (t >= a && t < b) : (t >= a || t < b);
  }

  /* Bir site için geçerli (efektif) ayarlar.
   * Dönüş: settings alanları + { mode (nihai), host, siteOverride: bool, scheduled: bool } */
  function effectiveFor(host, data, now) {
    const s = data.settings;
    const site = (data.sites || {})[host] || {};
    const eff = clone(s);
    for (const k of SITE_KEYS) if (site[k] !== undefined) eff[k] = site[k];
    eff.host = host;
    eff.siteOverride = Object.keys(site).length > 0;
    let mode = eff.mode;
    if (!s.enabled || site.disabled) mode = 'off';
    // Zamanlama yalnızca site özel bir mod belirtmemişse geçerli
    eff.scheduled = false;
    if (mode !== 'off' && site.mode === undefined && s.schedule.type !== 'off') {
      eff.scheduled = true;
      if (!isNightNow(s.schedule, now)) mode = 'off';
    }
    eff.mode = MODES.includes(mode) ? mode : 'off';
    return eff;
  }

  async function saveSettings(patch) {
    const { settings } = await getAll();
    const next = Object.assign(settings, patch);
    if (patch.schedule) next.schedule = Object.assign(settings.schedule, patch.schedule);
    if (patch.reader) next.reader = Object.assign(settings.reader, patch.reader);
    await chrome.storage.sync.set({ settings: next });
    return next;
  }

  async function saveSite(host, patch) {
    if (!host) return;
    const { sites } = await getAll();
    const cur = Object.assign(sites[host] || {}, patch);
    for (const k of Object.keys(cur)) if (cur[k] === null || cur[k] === undefined) delete cur[k];
    if (Object.keys(cur).length) sites[host] = cur; else delete sites[host];
    await chrome.storage.sync.set({ sites });
    return cur;
  }

  async function clearSite(host) {
    const { sites } = await getAll();
    delete sites[host];
    await chrome.storage.sync.set({ sites });
  }

  // Bu sitede tema aç/kapat (kısayol ve sağ tık menüsü için)
  async function toggleSite(host) {
    const data = await getAll();
    const eff = effectiveFor(host, data);
    if (eff.mode === 'off') {
      const m = data.settings.mode === 'off' ? 'dark' : data.settings.mode;
      await saveSite(host, { disabled: null, mode: m });
    } else {
      await saveSite(host, { disabled: true, mode: null });
    }
  }

  // Modlar arasında döngü (site bazlı)
  async function cycleSite(host) {
    const data = await getAll();
    const eff = effectiveFor(host, data);
    const order = ['dark', 'sepia', 'light', 'custom', 'off'];
    const next = order[(order.indexOf(eff.mode) + 1) % order.length];
    await saveSite(host, next === 'off' ? { disabled: true, mode: null } : { disabled: null, mode: next });
    return next;
  }

  /* Mesaj protokolü (content script dinler):
   *  { type: 'GO_TOGGLE_READER' }            -> { open: bool }
   *  { type: 'GO_OPEN_READER' }              -> { open: true }
   *  { type: 'GO_GET_STATE' }                -> { host, mode, readerOpen, readable }
   *  { type: 'GO_READER_TTS', action: 'play'|'pause'|'stop' } -> { ok }
   * Tema değişiklikleri mesajla değil chrome.storage.onChanged ile yayılır. */
  const MSG = {
    TOGGLE_READER: 'GO_TOGGLE_READER',
    OPEN_READER: 'GO_OPEN_READER',
    GET_STATE: 'GO_GET_STATE',
    READER_TTS: 'GO_READER_TTS'
  };

  globalThis.GO = { MODES, MODE_LABELS, DEFAULTS, SITE_KEYS, MSG, clone, hostOf, getAll, isNightNow, effectiveFor, saveSettings, saveSite, clearSite, toggleSite, cycleSite };
})();
