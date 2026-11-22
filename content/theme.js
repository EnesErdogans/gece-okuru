/* Gece Okuru — tema içerik betiği (document_start, üst çerçeve).
 * Her siteye karanlık / aydınlık / sepya / özel tema, tipografi ayarları,
 * mavi ışık filtresi ve karartma katmanı uygular. */
(function () {
  'use strict';
  if (window.__goThemeLoaded) return;
  window.__goThemeLoaded = true;

  const GO = globalThis.GO;
  if (!GO || typeof chrome === 'undefined' || !chrome.storage) return;

  const STYLE_ID = 'go-theme-style';
  const WARM_ID = 'go-warm';
  const DIM_ID = 'go-dim';
  const INV = 'invert(1) hue-rotate(180deg)';
  // Ters çevrilmiş sayfada fotoğrafların normal görünmesi için yeniden ters çevrilen öğeler
  const MEDIA = 'img, picture, video, canvas, iframe, embed, object, svg image, [style*="background-image"], [class*="emoji"]';

  const host = GO.hostOf(location.href);
  let data = null;
  let eff = null;
  let currentMode = 'off';
  let inverted = false;
  let pageDark = null;      // null = henüz tespit edilmedi
  let bodyPlain = true;     // body arka planı şeffaf/beyaz mı (sepya tonu için)
  let styleEl = null;
  let observer = null;

  /* ---------- yardımcılar ---------- */

  function parseColor(str) {
    const m = String(str || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function luminance(c) {
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  function clampNum(v, def, min, max) {
    const n = Number(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function lighten(hex, amt) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return hex;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    const mix = (c) => Math.round(c + (255 - c) * amt);
    return 'rgb(' + mix((n >> 16) & 255) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
  }

  // CSS değerine kaçış (</style> veya } enjeksiyonunu engelle)
  function safe(v) {
    return String(v == null ? '' : v).replace(/[<>{};]/g, '');
  }

  function adjustFilter(e) {
    const b = clampNum(e.brightness, 100, 10, 300);
    const c = clampNum(e.contrast, 100, 10, 300);
    const g = clampNum(e.grayscale, 0, 0, 100);
    const parts = [];
    if (b !== 100) parts.push('brightness(' + b + '%)');
    if (c !== 100) parts.push('contrast(' + c + '%)');
    if (g > 0) parts.push('grayscale(' + g + '%)');
    return parts.join(' ');
  }

  /* ---------- sayfa koyu mu tespiti ---------- */

  function detect() {
    try {
      const body = document.body;
      const html = document.documentElement;
      if (!html) return;
      // Kendi stilimizi geçici olarak devre dışı bırak (senkron, yeniden boyama olmaz)
      const sheet = styleEl && styleEl.sheet;
      if (sheet) sheet.disabled = true;
      let bg = null;
      let bodyBg = null;
      try {
        for (const el of [body, html]) {
          if (!el) continue;
          const c = parseColor(getComputedStyle(el).backgroundColor);
          if (el === body) bodyBg = c;
          if (c && c.a > 0.05) { bg = c; break; }
        }
      } finally {
        if (sheet) sheet.disabled = false;
      }
      const dark = bg ? luminance(bg) < 0.35 : false; // şeffafsa tuval beyazdır
      bodyPlain = !bodyBg || bodyBg.a <= 0.05 || luminance(bodyBg) > 0.95;
      if (dark !== pageDark || currentMode === 'sepia') {
        pageDark = dark;
        render();
      }
    } catch (e) { /* yoksay */ }
  }

  function scheduleDetection() {
    const run = () => { detect(); setTimeout(detect, 1500); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
    window.addEventListener('load', detect, { once: true });
  }

  /* ---------- CSS üretimi ---------- */

  function invertCss(adj) {
    return [
      'html { filter: ' + INV + (adj ? ' ' + adj : '') + ' !important; background-color: #fff !important; min-height: 100% !important; }',
      MEDIA + ' { filter: ' + INV + ' !important; }',
      // Çift ters çevirmeyi önle (ör. picture içindeki img)
      ':is(' + MEDIA + ') :is(' + MEDIA + ') { filter: none !important; }',
      'picture img { filter: none !important; }'
    ].join('\n');
  }

  function scrollbarCss(darkColors) {
    const track = darkColors ? '#1e1f22' : '#eeeeee';
    const thumb = darkColors ? '#4a4d52' : '#b8b8b8';
    const hover = darkColors ? '#5d6066' : '#9a9a9a';
    return [
      '::-webkit-scrollbar { width: 12px; height: 12px; background-color: ' + track + '; }',
      '::-webkit-scrollbar-track { background-color: ' + track + '; }',
      '::-webkit-scrollbar-thumb { background-color: ' + thumb + '; border-radius: 6px; border: 2px solid ' + track + '; }',
      '::-webkit-scrollbar-thumb:hover { background-color: ' + hover + '; }',
      '::-webkit-scrollbar-corner { background-color: ' + track + '; }'
    ].join('\n');
  }

  function typographyCss(e) {
    const out = [];
    const ff = safe(e.fontFamily).trim();
    if (ff) {
      out.push('body, body *:not(code):not(pre):not(kbd):not(samp):not([class*="icon"]):not(i) { font-family: ' + ff + ' !important; }');
    }
    const fs = clampNum(e.fontScale, 100, 50, 300);
    if (fs !== 100) out.push('body { zoom: ' + fs + '% !important; }');
    const lh = clampNum(e.lineHeight, 0, 0, 5);
    if (lh > 0) out.push('p, li, dd, blockquote, td { line-height: ' + lh + ' !important; }');
    return out.join('\n');
  }

  function buildCss(e) {
    const mode = e.mode;
    const adj = adjustFilter(e);
    const css = [];
    inverted = false;

    if (mode === 'dark') {
      if (pageDark === true) {
        css.push('html { color-scheme: dark !important;' + (adj ? ' filter: ' + adj + ' !important;' : '') + ' }');
        css.push(scrollbarCss(true));
      } else {
        // Tespitten önce de ters çevir: beyaz parlamayı önler
        inverted = true;
        css.push(invertCss(adj));
        // İçerik filtrelendiği için açık renkler ters çevrilince koyu görünür
        css.push(scrollbarCss(false));
      }
    } else if (mode === 'light') {
      if (pageDark === true) {
        inverted = true;
        css.push(invertCss(adj));
        css.push('html { color-scheme: light !important; }');
      } else if (adj) {
        css.push('html { filter: ' + adj + ' !important; }');
      }
    } else if (mode === 'sepia') {
      const b = clampNum(e.brightness, 100, 10, 300);
      const c = clampNum(e.contrast, 100, 10, 300);
      const g = clampNum(e.grayscale, 0, 0, 100);
      css.push('html { filter: sepia(0.6) brightness(' + b + '%) contrast(' + c + '%)' + (g > 0 ? ' grayscale(' + g + '%)' : '') + ' !important; background-color: #f4ecd8 !important; min-height: 100% !important; }');
      if (bodyPlain) css.push('body { background-color: #f4ecd8 !important; }');
    } else if (mode === 'custom') {
      const bg = safe(e.customBg) || '#1b1d23';
      const fg = safe(e.customText) || '#e6e6e6';
      const link = safe(e.customLink) || '#7fb4ff';
      const ctl = lighten(bg, 0.08);
      css.push(
        'html, body, body *:not(img):not(video):not(svg):not(canvas):not(picture) { background-color: transparent !important; color: ' + fg + ' !important; border-color: rgba(127,127,127,.35) !important; box-shadow: none !important; text-shadow: none !important; }',
        'html, body { background-color: ' + bg + ' !important; }',
        'a, a * { color: ' + link + ' !important; }',
        'input, textarea, select, button { background-color: ' + ctl + ' !important; color: ' + fg + ' !important; }',
        'input::placeholder, textarea::placeholder { color: ' + fg + ' !important; opacity: .55 !important; }'
      );
      if (adj) css.push('html { filter: ' + adj + ' !important; }');
      const lum = (() => { const m = parseColor(lighten(bg, 0)); return m ? luminance(m) : 0; })();
      css.push('html { color-scheme: ' + (lum < 0.5 ? 'dark' : 'light') + ' !important; }');
    }

    css.push(typographyCss(e));
    return css.filter(Boolean).join('\n');
  }

  /* ---------- DOM yönetimi ---------- */

  function root() { return document.documentElement; }

  function ensureStyle() {
    const r = root();
    if (!r) return null;
    if (!styleEl) {
      styleEl = document.getElementById(STYLE_ID) || document.createElement('style');
      styleEl.id = STYLE_ID;
    }
    if (!styleEl.isConnected) r.appendChild(styleEl);
    return styleEl;
  }

  function removeEl(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function overlay(id, color, blend) {
    const r = root();
    if (!r) return;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('aria-hidden', 'true');
    }
    el.style.cssText = [
      'position:fixed', 'inset:0', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
      'pointer-events:none', 'z-index:2147483646', 'margin:0', 'padding:0', 'border:0',
      'background:' + color, blend ? 'mix-blend-mode:' + blend : '',
      inverted ? 'filter:' + INV : 'filter:none'
    ].filter(Boolean).map((d) => d + ' !important').join(';');
    if (!el.isConnected) r.appendChild(el);
  }

  function renderOverlays() {
    const siteDisabled = !!(data && data.sites && data.sites[host] && data.sites[host].disabled);
    const allowed = !!(data && data.settings && data.settings.enabled) && !siteDisabled;
    const warmth = allowed ? clampNum(eff && eff.warmth, 0, 0, 100) : 0;
    const dim = allowed ? clampNum(eff && eff.dim, 0, 0, 95) : 0;
    if (warmth > 0) overlay(WARM_ID, 'rgba(255,140,0,' + (warmth / 100 * 0.35).toFixed(3) + ')', 'multiply');
    else removeEl(WARM_ID);
    if (dim > 0) overlay(DIM_ID, 'rgba(0,0,0,' + (dim / 100).toFixed(3) + ')', '');
    else removeEl(DIM_ID);
    return warmth > 0 || dim > 0;
  }

  // Sayfa betikleri düğümlerimizi silerse geri ekle
  function watch(on) {
    if (!on) {
      if (observer) { observer.disconnect(); observer = null; }
      return;
    }
    if (observer || !root()) return;
    observer = new MutationObserver(() => {
      if (styleEl && !styleEl.isConnected && currentMode !== 'off') root() && root().appendChild(styleEl);
      for (const id of [WARM_ID, DIM_ID]) {
        // overlay() eksikse yeniden oluşturur
        if (!document.getElementById(id)) { renderOverlays(); break; }
      }
    });
    observer.observe(root(), { childList: true });
  }

  function render() {
    try {
      if (!eff) return;
      currentMode = eff.mode;
      if (currentMode === 'off') {
        inverted = false;
        if (styleEl) { styleEl.textContent = ''; styleEl.remove(); }
        removeEl(STYLE_ID);
        styleEl = null;
      } else {
        const css = buildCss(eff);
        const el = ensureStyle();
        if (el && el.textContent !== css) el.textContent = css;
      }
      const hasOverlay = renderOverlays();
      watch(currentMode !== 'off' || hasOverlay);
    } catch (e) { /* yoksay */ }
  }

  /* ---------- ayarlar ---------- */

  function recompute() {
    if (!data) return;
    try {
      eff = GO.effectiveFor(host, data);
      render();
    } catch (e) { /* yoksay */ }
  }

  async function reload() {
    try {
      data = await GO.getAll();
      recompute();
    } catch (e) { /* uzantı bağlamı geçersiz olabilir */ }
  }

  function reapply() {
    return reload();
  }

  window.__goTheme = {
    reapply,
    getMode: () => currentMode,
    isInverted: () => inverted
  };

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && (changes.settings || changes.sites)) reload();
    });
  } catch (e) { /* yoksay */ }

  setInterval(() => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return; // uzantı yeniden yüklendi
      recompute();
    } catch (e) { /* yoksay */ }
  }, 60000);

  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => recompute();
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  } catch (e) { /* yoksay */ }

  scheduleDetection();
  reload();
})();
