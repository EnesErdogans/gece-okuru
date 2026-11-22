/* Gece Okuru — Okuma modu (content script, document_idle).
 * Her sitede çalışan, Shadow DOM içinde açılan okuma görünümü:
 * makale çıkarma (Readability benzeri, kendi yazımımız), tema/yazı tipi ayarları,
 * sesli okuma (speechSynthesis), odak cetveli, yazdırma ve metin kopyalama. */
(function () {
  'use strict';

  /* Çift enjeksiyon koruması (Node/jsdom testinde window yoktur). */
  if (typeof window !== 'undefined') {
    if (window.__goReaderLoaded) return;
    window.__goReaderLoaded = true;
  }

  /* =====================================================================
   * 1) MAKALE ÇIKARMA
   * ===================================================================== */

  const JUNK_SELECTOR = [
    'script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside', 'object', 'embed',
    'canvas', 'button', 'input', 'select', 'textarea', 'link', 'meta', 'template', 'dialog',
    'svg', 'audio', 'video', 'map', 'frame', 'frameset',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]', '[role="dialog"]',
    '[role="alertdialog"]', '[hidden]', '[aria-hidden="true"]', '#go-reader-host'
  ].join(',');

  const NEGATIVE = /comment|sidebar|share|sharing|social|related|promo|advert|(^|[\s_-])ads?([\s_-]|$)|(^|[\s_])ad-|cookie|newsletter|popup|modal|footer|(^|[\s_-])nav|menu|breadcrumb|banner|sponsor|widget|subscribe|disqus|outbrain|taboola|signup|paywall|consent|gdpr|masthead|toolbar|pagination|pager|tags?-list|author-box|rating/i;
  const POSITIVE = /article|content|post|entry|main|story|body|text|blog|prose|hentry/i;
  const STRONG_POSITIVE = /articlebody|article-body|post-body|entry-content|post-content|article-content|story-body|main-content/i;

  const CANDIDATE_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN', 'TD', 'BODY']);

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function textOf(el) { return norm(el && el.textContent); }

  function classIdStr(el) {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return c + ' ' + (el.id || '');
  }

  function classWeight(el) {
    const s = classIdStr(el);
    if (!norm(s)) return 0;
    let w = 0;
    if (NEGATIVE.test(s)) w -= 25;
    if (POSITIVE.test(s)) w += 25;
    if (STRONG_POSITIVE.test(s)) w += 25;
    return w;
  }

  function linkDensity(el, txtLen) {
    const len = txtLen != null ? txtLen : textOf(el).length;
    if (!len) return 0;
    let l = 0;
    el.querySelectorAll('a').forEach(a => { l += textOf(a).length; });
    return Math.min(1, l / len);
  }

  function paragraphCount(el) {
    let n = 0;
    el.querySelectorAll('p').forEach(p => { if (textOf(p).length > 60) n++; });
    return n;
  }

  function metaContent(doc, sels) {
    for (const s of sels) {
      const m = doc.querySelector(s);
      const v = m && norm(m.getAttribute('content') || m.textContent);
      if (v) return v;
    }
    return '';
  }

  function cleanDocTitle(t, site) {
    t = norm(t);
    const parts = t.split(/\s+[|\-–—·»:]\s+/);
    if (parts.length > 1) {
      // Site adını içeren son parçayı at, kalan anlamlıysa onu kullan
      const first = parts.slice(0, -1).join(' - ');
      if (first.length >= 15 || (site && parts[parts.length - 1].toLowerCase().includes(site.toLowerCase()))) return first;
    }
    return t;
  }

  function getMeta(doc, baseUrl) {
    let host = '';
    try { host = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch (e) { /* yok */ }
    const site = metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]', 'meta[name="og:site_name"]']) || host;
    let title = metaContent(doc, ['meta[property="og:title"]', 'meta[name="og:title"]', 'meta[name="twitter:title"]']);
    if (!title) {
      const h1 = doc.querySelector('article h1, main h1, h1');
      title = h1 ? textOf(h1) : '';
    }
    if (!title) title = cleanDocTitle(doc.title || '', site);
    let author = metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]', 'meta[name="sailthru.author"]', 'meta[name="parsely-author"]']);
    if (/^https?:\/\//i.test(author)) author = '';
    if (!author) {
      const a = doc.querySelector('[itemprop="author"] [itemprop="name"], [itemprop="author"], [rel="author"], .byline .author, .author-name');
      const t = a ? textOf(a) : '';
      if (t && t.length < 80) author = t;
    }
    return { title: title || host || 'Okuma modu', author, site, host };
  }

  function absUrl(u, base) {
    try { return new URL(u, base).href; } catch (e) { return ''; }
  }

  function pickFromSrcset(ss) {
    if (!ss) return '';
    let best = '', bestV = -1;
    const re = /\s*([^\s,][^\s]*?)(?:\s+([\d.]+)([wxh]))?\s*(?:,|$)/g;
    let m;
    while ((m = re.exec(ss))) {
      if (!m[1]) { if (re.lastIndex >= ss.length) break; continue; }
      const v = m[2] ? parseFloat(m[2]) * (m[3] === 'x' ? 1000 : 1) : 1;
      if (v > bestV) { bestV = v; best = m[1]; }
      if (re.lastIndex >= ss.length) break;
    }
    return best;
  }

  const PLACEHOLDER = /blank|placeholder|spacer|transparent|lazy|loading|1x1|pixel|grey\.gif|data:image\/(gif|svg)/i;

  function resolveImgSrc(img, base) {
    const attr = n => (img.getAttribute(n) || '').trim();
    const src = attr('src');
    const lazy = attr('data-src') || attr('data-lazy-src') || attr('data-original') || attr('data-url') ||
      attr('data-hi-res-src') || attr('data-full-src') || attr('data-lazy') || attr('data-actualsrc');
    const ss = pickFromSrcset(attr('srcset') || attr('data-srcset') || attr('data-lazy-srcset'));
    let chosen = '';
    if (src && !src.startsWith('data:') && !(PLACEHOLDER.test(src) && (lazy || ss))) chosen = src;
    if (!chosen) chosen = lazy || ss;
    if (!chosen) {
      // <picture><source srcset>
      const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
      if (pic) {
        const s = pic.querySelector('source[srcset], source[data-srcset]');
        if (s) chosen = pickFromSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset'));
      }
    }
    if (!chosen && src.startsWith('data:image/') && src.length > 400) return src; // gerçek gömülü görsel
    if (!chosen) return '';
    const u = absUrl(chosen, base);
    return /^https?:/i.test(u) ? u : '';
  }

  const INLINE_KEEP = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'SUP', 'SUB', 'MARK', 'SMALL', 'S', 'DEL', 'INS', 'KBD', 'Q', 'ABBR', 'U']);
  const BLOCK_KEEP = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'FIGURE', 'FIGCAPTION', 'HR']);
  const INLINE_UNWRAP = new Set(['SPAN', 'FONT', 'TIME', 'LABEL', 'CITE', 'BDI', 'BDO', 'DFN', 'VAR', 'SAMP', 'DATA', 'NOBR', 'BIG', 'TT', 'WBR']);
  const TAG_MAP = { H5: 'H4', H6: 'H4' };
  const FLOW_CHILDREN = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'DT', 'DD', 'LI', 'TH', 'TD', 'CAPTION', 'FIGCAPTION', 'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

  /* Kaynak ağacını yalnızca izinli etiket/özniteliklerle yeniden kurar (inert belgede). */
  function sanitizeInto(src, outDoc, base) {
    const root = outDoc.createElement('div');

    function isEmpty(el) {
      return !norm(el.textContent) && !el.querySelector('img,hr,br');
    }

    function makeImg(img) {
      const s = resolveImgSrc(img, base);
      if (!s) return null;
      const w = parseInt(img.getAttribute('width'), 10), h = parseInt(img.getAttribute('height'), 10);
      if ((w && w < 3) || (h && h < 3) || (w && h && w <= 40 && h <= 40)) return null;
      const out = outDoc.createElement('img');
      out.setAttribute('src', s);
      const alt = img.getAttribute('alt');
      if (alt) out.setAttribute('alt', alt);
      return out;
    }

    function walk(node, out, mode, state) {
      const inlineTarget = () => {
        if (mode !== 'block') return out;
        if (!state.pend) { state.pend = outDoc.createElement('p'); out.appendChild(state.pend); }
        return state.pend;
      };
      for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
        if (ch.nodeType === 3) {
          const t = ch.nodeValue;
          if (mode === 'block' && !state.pend && !/\S/.test(t)) continue;
          inlineTarget().appendChild(outDoc.createTextNode(t));
          continue;
        }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName.toUpperCase();
        if (tag === 'IMG') {
          const im = makeImg(ch);
          if (!im) continue;
          if (mode === 'block') { state.pend = null; out.appendChild(im); } else out.appendChild(im);
          continue;
        }
        if (tag === 'PICTURE') {
          const inner = ch.querySelector('img');
          const im = inner && makeImg(inner);
          if (im) { if (mode === 'block') { state.pend = null; } out.appendChild(im); }
          continue;
        }
        if (tag === 'BR') {
          if (mode === 'block') { if (state.pend) state.pend.appendChild(outDoc.createElement('br')); }
          else out.appendChild(outDoc.createElement('br'));
          continue;
        }
        if (INLINE_KEEP.has(tag)) {
          const el = outDoc.createElement(tag);
          if (tag === 'A') {
            const href = ch.getAttribute('href');
            if (href && !/^\s*(javascript|data|vbscript):/i.test(href)) {
              const u = absUrl(href, base);
              if (/^(https?|mailto):/i.test(u)) el.setAttribute('href', u);
            }
          }
          walk(ch, el, 'flow', { pend: null });
          if (!isEmpty(el)) inlineTarget().appendChild(el);
          continue;
        }
        if (INLINE_UNWRAP.has(tag)) { walk(ch, out, mode, state); continue; }
        if (BLOCK_KEEP.has(tag)) {
          if (mode === 'block') state.pend = null;
          const nt = TAG_MAP[tag] || tag;
          const el = outDoc.createElement(nt);
          if (tag === 'TD' || tag === 'TH') {
            for (const a of ['colspan', 'rowspan']) { const v = ch.getAttribute(a); if (v && /^\d+$/.test(v)) el.setAttribute(a, v); }
          }
          if (tag === 'PRE') {
            el.textContent = ch.textContent.replace(/^\n+|\s+$/g, '');
          } else if (tag !== 'HR') {
            walk(ch, el, FLOW_CHILDREN.has(nt) ? 'flow' : 'block', { pend: null });
          }
          const keepEmpty = tag === 'HR' || tag === 'TD' || tag === 'TH';
          if (keepEmpty || !isEmpty(el)) {
            if (nt === 'TR' || nt === 'TBODY' || nt === 'THEAD' || nt === 'TFOOT') {
              // Tablo satırlarındaki boşluk metinlerini temizle
              for (let c = el.firstChild; c;) { const n = c.nextSibling; if (c.nodeType === 3) el.removeChild(c); c = n; }
            }
            out.appendChild(el);
          }
          continue;
        }
        // DIV, SECTION, ARTICLE, HEADER ve bilinmeyen öğeler: aç (unwrap), blok sınırı say
        if (mode === 'block') {
          state.pend = null;
          walk(ch, out, mode, state);
          state.pend = null;
        } else {
          if (out.lastChild && out.lastChild.nodeType === 3 && !/\s$/.test(out.lastChild.nodeValue)) out.appendChild(outDoc.createTextNode(' '));
          walk(ch, out, mode, state);
          out.appendChild(outDoc.createTextNode(' '));
        }
      }
    }

    walk(src, root, 'block', { pend: null });
    // Boş paragrafları ve tekrar eden görselleri temizle
    root.querySelectorAll('p').forEach(p => { if (isEmpty(p)) p.remove(); });
    const seen = new Set();
    root.querySelectorAll('img').forEach(im => {
      const s = im.getAttribute('src');
      if (seen.has(s)) im.remove(); else seen.add(s);
    });
    root.querySelectorAll('figure').forEach(f => { if (isEmpty(f)) f.remove(); });
    return root;
  }

  /* Ana çıkarma fonksiyonu. doc: Document, baseUrl: sayfa adresi.
   * Dönüş: { title, author, site, host, contentEl (inert belgede div), text, words, readable } */
  function extractArticle(doc, baseUrl) {
    baseUrl = baseUrl || doc.baseURI || '';
    const meta = getMeta(doc, baseUrl);
    const inert = doc.implementation.createHTMLDocument('');
    const body = doc.body ? inert.importNode(doc.body, true) : inert.createElement('body');

    // 1. Çöp öğeleri kaldır
    body.querySelectorAll(JUNK_SELECTOR).forEach(el => {
      if (!el.isConnected && !body.contains(el)) return;
      const t = el.tagName;
      if ((t === 'NAV' || el.getAttribute('role')) && el.querySelector('article, [itemprop="articleBody"]')) return;
      el.remove();
    });
    body.querySelectorAll('[style]').forEach(el => {
      const st = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
      if (st.includes('display:none') || st.includes('visibility:hidden')) el.remove();
    });
    // Formlar: sayfanın tamamını saran formlar (ör. ASP.NET) dışında kaldır
    body.querySelectorAll('form').forEach(f => {
      if (!body.contains(f)) return;
      if (paragraphCount(f) < 3) f.remove();
    });
    // Makale dışındaki header'lar
    body.querySelectorAll('header').forEach(h => {
      if (body.contains(h) && !h.closest('article') && !h.querySelector('article, [itemprop="articleBody"]')) h.remove();
    });

    // 2. Sınıf/kimlik bazlı puanlama ile olası olmayan öğeleri kaldır
    Array.from(body.querySelectorAll('*')).forEach(el => {
      if (!body.contains(el)) return;
      const tag = el.tagName;
      if (tag === 'ARTICLE' || tag === 'MAIN' || tag === 'BODY' || tag === 'HTML') return;
      if (el.getAttribute('itemprop') === 'articleBody') return;
      const s = classIdStr(el);
      if (!NEGATIVE.test(s)) return;
      if (classWeight(el) > 0) return; // güçlü pozitif sinyal
      if (el.querySelector('article, main, [itemprop="articleBody"]')) return;
      // Sayfanın büyük kısmını saran sarmalayıcıları koru (ör. "has-sidebar")
      const len = textOf(el).length;
      if (len > 1500 && paragraphCount(el) >= 5 && linkDensity(el, len) < 0.25) return;
      el.remove();
    });

    // 3. Tercih edilen kapsayıcı: [itemprop=articleBody] veya <article>
    let chosen = null;
    const pickBest = sel => {
      let best = null, bestLen = 0;
      body.querySelectorAll(sel).forEach(el => {
        const len = textOf(el).length;
        if (len > bestLen && linkDensity(el, len) < 0.4) { best = el; bestLen = len; }
      });
      return bestLen >= 500 ? best : null;
    };
    chosen = pickBest('[itemprop="articleBody"]') || pickBest('article');

    // 4. Aday puanlama
    if (!chosen) {
      const scores = new Map();
      const initScore = el => {
        let s = 0;
        switch (el.tagName) {
          case 'ARTICLE': s = 10; break;
          case 'MAIN': s = 8; break;
          case 'DIV': s = 5; break;
          case 'SECTION': case 'TD': s = 3; break;
          default: s = 0;
        }
        return s + classWeight(el);
      };
      const blocks = body.querySelectorAll('p, pre, blockquote, div, section, td');
      blocks.forEach(b => {
        if (b.tagName === 'DIV' || b.tagName === 'SECTION' || b.tagName === 'TD') {
          // Yalnızca blok çocuğu olmayan, doğrudan metin taşıyan div'ler paragraf sayılır
          if (b.querySelector('p, div, section, article, table, ul, ol, pre, blockquote, h1, h2, h3')) return;
        }
        const t = textOf(b);
        if (t.length < 25) return;
        let score = 1 + (t.match(/[,،、，]/g) || []).length + Math.min(Math.floor(t.length / 100), 3);
        let anc = b.parentElement, lvl = 0;
        while (anc && lvl < 3) {
          if (CANDIDATE_TAGS.has(anc.tagName)) {
            if (!scores.has(anc)) scores.set(anc, initScore(anc));
            scores.set(anc, scores.get(anc) + score / (lvl === 0 ? 1 : lvl === 1 ? 2 : lvl * 3));
          }
          anc = anc.parentElement; lvl++;
        }
      });
      let top = null, topScore = 0;
      const finalScore = new Map();
      scores.forEach((s, el) => {
        const ld = linkDensity(el);
        let f = s * (1 - ld);
        if (ld > 0.4) f *= 0.25;
        finalScore.set(el, f);
        if (f > topScore) { topScore = f; top = el; }
      });
      // Üst öğe büyük ölçüde aynı içeriği taşıyorsa ve daha yüksek skorluysa ona çık
      if (top && top.tagName !== 'BODY') {
        let p = top.parentElement;
        while (p && p.tagName !== 'BODY' && finalScore.has(p) && finalScore.get(p) >= topScore * 0.9 && textOf(p).length < textOf(top).length * 1.5) {
          top = p; topScore = finalScore.get(p); p = p.parentElement;
        }
      }
      if (top) {
        // Kardeşleri birleştir
        const parent = top.parentElement;
        if (parent && top.tagName !== 'BODY') {
          const threshold = Math.max(10, topScore * 0.2);
          const wrap = inert.createElement('div');
          Array.from(parent.children).forEach(sib => {
            let ok = sib === top;
            if (!ok && classWeight(sib) >= 0) {
              const fs = finalScore.get(sib);
              if (fs && fs >= threshold) ok = true;
              else if (sib.tagName === 'P') {
                const t = textOf(sib), ld = linkDensity(sib, t.length);
                if (t.length > 80 && ld < 0.25) ok = true;
                else if (t.length && t.length <= 80 && ld === 0 && /\.( |$)/.test(t)) ok = true;
              } else if (/^H[2-4]$/.test(sib.tagName) && sib.nextElementSibling === top) ok = true;
              else if (sib.tagName === 'FIGURE' || (sib.tagName !== 'P' && sib.querySelector && sib.children.length === 1 && sib.querySelector('img') && !textOf(sib))) {
                ok = Math.abs(Array.prototype.indexOf.call(parent.children, sib) - Array.prototype.indexOf.call(parent.children, top)) <= 1;
              }
            }
            if (ok) wrap.appendChild(sib.cloneNode(true));
          });
          chosen = wrap;
        } else {
          chosen = top;
        }
      }
    }

    let readable = false;
    let contentEl = null;
    if (chosen) {
      contentEl = sanitizeInto(chosen, inert, baseUrl);
      readable = textOf(contentEl).length >= 500;
    }
    if (!readable) {
      // Net içerik yok: temizlenmiş gövde metninin tamamı
      const full = sanitizeInto(body, inert, baseUrl);
      if (!contentEl || textOf(full).length > textOf(contentEl).length) contentEl = full;
      readable = false;
    }
    // İlk başlık sayfa başlığıyla aynıysa kaldır (zaten üstte gösteriliyor)
    const firstH = contentEl.querySelector('h1, h2');
    if (firstH && meta.title) {
      const a = textOf(firstH).toLowerCase(), b = meta.title.toLowerCase();
      if (a && (a === b || (a.length > 10 && b.includes(a)) || (b.length > 10 && a.includes(b)))) {
        const before = [];
        for (let n = contentEl.firstChild; n && n !== firstH; n = n.nextSibling) before.push(n);
        if (before.every(n => !norm(n.textContent) && !(n.querySelector && n.querySelector('img')))) firstH.remove();
      }
    }
    const text = textOf(contentEl);
    const words = text ? text.split(/\s+/).length : 0;
    return Object.assign(meta, { contentEl, text, words, readable });
  }

  /* Metni <200 karakterlik cümle parçalarına böler (Chrome uzun söyleyiş kesintisine karşı). */
  function chunkText(text, max) {
    max = max || 190;
    text = norm(text);
    if (!text) return [];
    const sentences = text.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [text];
    const out = [];
    let cur = '';
    const pushLong = s => {
      // Uzun cümleyi virgül/boşluklardan böl
      let rest = s.trim();
      while (rest.length > max) {
        let cut = rest.lastIndexOf(', ', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf('; ', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
        if (cut <= 0) cut = max;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
      return rest;
    };
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      if ((cur + ' ' + s).trim().length <= max) { cur = (cur + ' ' + s).trim(); continue; }
      if (cur) out.push(cur);
      cur = s.length > max ? pushLong(s) : s;
    }
    if (cur) out.push(cur);
    return out.filter(Boolean);
  }

  function looksTurkish(text) {
    const sample = String(text || '').slice(0, 4000);
    const special = (sample.match(/[ığşİĞŞ]/g) || []).length;
    const words = (sample.match(/(^|\s)(ve|bir|bu|için|ile|olarak|daha|çok|gibi|kadar|değil)(?=\s|[.,;:!?]|$)/gi) || []).length;
    return special >= 5 && words >= 3;
  }

  /* Node/jsdom testleri için: yalnızca saf fonksiyonları dışa aktar. */
  if (typeof window === 'undefined') {
    if (typeof module === 'object' && module && module.exports) {
      module.exports = { extractArticle, chunkText, looksTurkish };
    }
    return;
  }

  /* =====================================================================
   * 2) OKUMA GÖRÜNÜMÜ
   * ===================================================================== */

  const GO = globalThis.GO || null;
  const DEFAULT_PREFS = (GO && GO.DEFAULTS && GO.DEFAULTS.settings && GO.DEFAULTS.settings.reader) ||
    { theme: 'auto', font: 'serif', size: 20, width: 720, lineHeight: 1.7, ttsRate: 1, ruler: false };

  const FONTS = {
    serif: 'Charter, "Bitstream Charter", "Iowan Old Style", "Source Serif Pro", Georgia, Cambria, "Times New Roman", serif',
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    dyslexia: '"Comic Sans MS", OpenDyslexic, sans-serif'
  };
  const WIDTHS = { narrow: 560, normal: 720, wide: 900 };
  const RATES = [0.75, 1, 1.25, 1.5, 2];

  let prefs = Object.assign({}, DEFAULT_PREFS);
  let prefsLoaded = false;
  let saveTimer = null;

  const R = {
    open: false, host: null, shadow: null, els: {}, article: null,
    savedOverflow: null, watchTimer: null, lastFocus: null, lang: ''
  };
  const tts = { queue: [], idx: 0, playing: false, paused: false, token: 0, current: null };
  let readableCache = { href: '', t: 0, v: false };

  async function ensurePrefs() {
    if (prefsLoaded) return;
    try {
      if (GO && GO.getAll) {
        const all = await GO.getAll();
        prefs = Object.assign({}, DEFAULT_PREFS, (all && all.settings && all.settings.reader) || {});
      }
    } catch (e) { /* varsayılanlarla devam */ }
    prefs.size = clamp(+prefs.size || 20, 14, 32);
    prefs.lineHeight = clamp(+prefs.lineHeight || 1.7, 1.3, 2.2);
    if (!Object.values(WIDTHS).includes(+prefs.width)) prefs.width = 720;
    if (!FONTS[prefs.font]) prefs.font = 'serif';
    if (!['light', 'sepia', 'dark', 'auto'].includes(prefs.theme)) prefs.theme = 'auto';
    if (!RATES.includes(+prefs.ttsRate)) prefs.ttsRate = 1;
    prefsLoaded = true;
  }

  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { if (GO && GO.saveSettings) GO.saveSettings({ reader: Object.assign({}, prefs) }).catch(() => {}); } catch (e) { /* bağlam geçersiz */ }
    }, 300);
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function themeApi() { return window.__goTheme || null; }
  function siteMode() {
    try { const t = themeApi(); return (t && t.getMode && t.getMode()) || 'off'; } catch (e) { return 'off'; }
  }
  function isInverted() {
    try { const t = themeApi(); return !!(t && t.isInverted && t.isInverted()); } catch (e) { return false; }
  }
  function effectiveTheme() {
    if (prefs.theme !== 'auto') return prefs.theme;
    const m = siteMode();
    if (m === 'dark') return 'dark';
    if (m === 'sepia') return 'sepia';
    return 'light';
  }

  const ICON = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
    ruler: '<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 8v3M11 8v4M15 8v3M19 8v2"/>',
    print: '<path d="M7 9V3.5h10V9"/><path d="M7 17H4.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H17"/><path d="M7 14h10v6.5H7z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    lhMinus: '<path d="M3 7h11M3 12h11M3 17h11M17 12h5"/>',
    lhPlus: '<path d="M3 7h11M3 12h11M3 17h11M17 12h5M19.5 9.5v5"/>',
    wNarrow: '<path d="M9.5 5v14M14.5 5v14"/>',
    wNormal: '<path d="M7 5v14M17 5v14"/>',
    wWide: '<path d="M4 5v14M20 5v14"/>'
  };
  const svg = p => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  --bg: #fbfaf7; --fg: #1f1f1f; --muted: #6d6a63; --link: #1d5fae; --link-hover: #0f3f7a;
  --line: rgba(31,31,31,.09); --hover: rgba(31,31,31,.06); --tb: rgba(251,250,247,.86);
  --accent: #c0692b; --hl: rgba(255,206,92,.38); --code: #f0ede6; --dim: rgba(20,18,14,.34);
  --sel: rgba(29,95,174,.18); --shadow: 0 1px 0 rgba(0,0,0,.04), 0 6px 24px -12px rgba(0,0,0,.18);
  --font: ${FONTS.serif}; --size: 20px; --lh: 1.7; --w: 720px;
  position: fixed; inset: 0; color: var(--fg); background: var(--bg);
  font: 400 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  transition: background-color .35s ease, color .35s ease;
  opacity: 0; animation: go-in .22s ease-out forwards;
}
@keyframes go-in { from { opacity: 0; } to { opacity: 1; } }
.root.t-sepia {
  --bg: #f4ecd8; --fg: #3b2f1e; --muted: #7c6a50; --link: #8c4a14; --link-hover: #5f300a;
  --line: rgba(59,47,30,.13); --hover: rgba(59,47,30,.08); --tb: rgba(244,236,216,.88);
  --accent: #a8612a; --hl: rgba(212,150,64,.30); --code: #ebe0c4; --dim: rgba(40,28,12,.34);
  --sel: rgba(140,74,20,.18);
}
.root.t-dark {
  --bg: #16181d; --fg: #d9dadc; --muted: #8d919a; --link: #8ab4f8; --link-hover: #b3cdfb;
  --line: rgba(255,255,255,.08); --hover: rgba(255,255,255,.07); --tb: rgba(22,24,29,.86);
  --accent: #e0a060; --hl: rgba(138,180,248,.17); --code: #20232a; --dim: rgba(0,0,0,.5);
  --sel: rgba(138,180,248,.25); --shadow: 0 1px 0 rgba(255,255,255,.03), 0 6px 24px -12px rgba(0,0,0,.6);
}
.root.t-dark img { opacity: .92; }
::selection { background: var(--sel); }

.scroller {
  position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; outline: none;
  background: var(--bg); transition: background-color .35s ease;
  scroll-behavior: smooth; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--line) transparent;
}

.progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 30; pointer-events: none; }
.progress > i { display: block; height: 100%; width: 100%; background: var(--accent); transform-origin: 0 50%; transform: scaleX(0); transition: transform .12s linear; opacity: .85; }

.toolbar {
  position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
  gap: 4px 6px; padding: 8px 12px; background: var(--tb); color: var(--fg);
  -webkit-backdrop-filter: saturate(1.4) blur(12px); backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--line); transition: background-color .35s ease, border-color .35s ease, transform .25s ease;
}
.grp { display: inline-flex; align-items: center; gap: 2px; padding: 0 4px; position: relative; }
.grp + .grp::before { content: ""; position: absolute; left: -3px; top: 6px; bottom: 6px; width: 1px; background: var(--line); }
.spacer { flex: 1 1 0; min-width: 0; }
button, select {
  font: inherit; color: inherit; background: transparent; border: 0; margin: 0;
  height: 32px; min-width: 32px; padding: 0 7px; border-radius: 8px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  transition: background-color .15s ease, color .15s ease, opacity .15s ease;
  font-size: 13px; line-height: 1; white-space: nowrap;
}
button:hover, select:hover { background: var(--hover); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button[aria-pressed="true"] { background: var(--hover); color: var(--accent); }
button:disabled { opacity: .35; cursor: default; background: transparent; }
select { appearance: none; -webkit-appearance: none; padding: 0 22px 0 9px; border: 1px solid var(--line);
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%; background-size: 4px 4px; background-repeat: no-repeat; }
select option { color: #1f1f1f; background: #fff; }
.txtbtn { font-weight: 600; letter-spacing: -.01em; font-size: 14px; }
.txtbtn small { font-size: 11px; font-weight: 600; }
.val { min-width: 24px; text-align: center; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--muted); }
.sw { width: 18px; height: 18px; border-radius: 50%; display: block; box-shadow: inset 0 0 0 1px rgba(0,0,0,.18); }
.sw.light { background: #fbfaf7; } .sw.sepia { background: #f4ecd8; } .sw.dark { background: #16181d; box-shadow: inset 0 0 0 1px rgba(255,255,255,.25); }
.sw.auto { background: linear-gradient(135deg, #fbfaf7 0 50%, #16181d 50% 100%); }
button.themebtn { min-width: 30px; padding: 0 6px; }
button.themebtn[aria-pressed="true"] { box-shadow: inset 0 0 0 1.5px var(--accent); background: transparent; }
button.close { color: var(--muted); }
button.close:hover { color: var(--fg); }

.page { max-width: var(--w); margin: 0 auto; padding: 56px 24px 30vh; transition: max-width .3s ease; }
.head { margin-bottom: 2.2em; font-family: var(--font); }
.site { font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin-bottom: 14px; }
h1.title { font-family: var(--font); font-size: calc(var(--size) * 1.75); line-height: 1.2; font-weight: 700; letter-spacing: -.015em; margin: 0 0 .6em; color: var(--fg); text-wrap: balance; }
.meta { font: 400 13.5px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--muted); display: flex; flex-wrap: wrap; gap: 0 10px; }
.meta span + span::before { content: "·"; margin-right: 10px; opacity: .7; }
.head::after { content: ""; display: block; width: 56px; height: 2px; background: var(--line); margin-top: 1.6em; border-radius: 2px; }
.notice { font: 400 13.5px/1.5 system-ui, sans-serif; color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; padding: 10px 14px; margin: 0 0 2em; }

.content { font-family: var(--font); font-size: var(--size); line-height: var(--lh); color: var(--fg); overflow-wrap: break-word; hyphens: auto;
  transition: font-size .2s ease, line-height .2s ease; }
.content > :first-child { margin-top: 0; }
.content p { margin: 0 0 1.05em; }
.content h1, .content h2, .content h3, .content h4 { font-family: var(--font); line-height: 1.28; letter-spacing: -.01em; margin: 1.8em 0 .6em; font-weight: 700; color: var(--fg); }
.content h1 { font-size: 1.5em; } .content h2 { font-size: 1.32em; } .content h3 { font-size: 1.15em; } .content h4 { font-size: 1.02em; }
.content a { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: .18em; text-decoration-color: color-mix(in srgb, var(--link) 45%, transparent); transition: color .15s, text-decoration-color .15s; }
.content a:hover { color: var(--link-hover); text-decoration-color: currentColor; }
.content img { display: block; max-width: 100%; height: auto; margin: 1.6em auto; border-radius: 6px; }
.content figure { margin: 2em 0; }
.content figure img { margin: 0 auto .6em; }
.content figcaption, .content caption { font: 400 .78em/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--muted); text-align: center; }
.content blockquote { margin: 1.5em 0; padding: .1em 0 .1em 1.1em; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }
.content blockquote p:last-child { margin-bottom: 0; }
.content ul, .content ol { margin: 0 0 1.1em; padding-left: 1.4em; }
.content li { margin: .3em 0; }
.content li::marker { color: var(--muted); }
.content pre { font-family: ${FONTS.mono}; font-size: .78em; line-height: 1.55; background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; white-space: pre; margin: 1.4em 0; tab-size: 4; }
.content code { font-family: ${FONTS.mono}; font-size: .86em; background: var(--code); padding: .1em .35em; border-radius: 4px; }
.content pre code { background: none; padding: 0; font-size: 1em; }
.content table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 1.5em 0; font-size: .85em; line-height: 1.45; }
.content th, .content td { border: 1px solid var(--line); padding: .45em .7em; text-align: left; vertical-align: top; }
.content th { background: var(--hover); font-weight: 600; }
.content hr { border: 0; height: 1px; background: var(--line); margin: 2.4em auto; width: 40%; }
.content dt { font-weight: 700; margin-top: .8em; } .content dd { margin: 0 0 .6em 1.2em; }
.content mark { background: var(--hl); color: inherit; }
.content sup, .content sub { line-height: 0; }
.go-speaking { background: var(--hl); border-radius: 4px; box-shadow: 0 0 0 .3em var(--hl); transition: background-color .25s ease, box-shadow .25s ease; }

.ruler { position: fixed; inset: 0; z-index: 15; pointer-events: none; opacity: 0; transition: opacity .2s ease; }
.ruler.on { opacity: 1; }
.ruler .d { position: absolute; left: 0; right: 0; background: var(--dim); transition: background-color .35s ease; }
.ruler .d.top { top: 0; height: var(--ry, 40vh); }
.ruler .d.bot { top: calc(var(--ry, 40vh) + var(--rh, 100px)); bottom: 0; }
.ruler .band { position: absolute; left: 0; right: 0; top: var(--ry, 40vh); height: var(--rh, 100px);
  border-top: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 5%, transparent); }

.toast { position: fixed; left: 50%; bottom: 28px; z-index: 40; transform: translate(-50%, 12px); opacity: 0; pointer-events: none;
  background: var(--fg); color: var(--bg); font: 500 13px/1 system-ui, sans-serif; padding: 10px 16px; border-radius: 999px;
  box-shadow: var(--shadow); transition: opacity .2s ease, transform .2s ease; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 640px) {
  .toolbar { gap: 2px; padding: 6px 6px; justify-content: flex-start; }
  .grp { padding: 0 2px; }
  .spacer { display: none; }
  .page { padding: 32px 16px 30vh; }
  h1.title { font-size: calc(var(--size) * 1.45); }
  .hide-sm { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .root, .root * { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
@media print { .toolbar, .progress, .ruler, .toast { display: none !important; } }
`;

  function toolbarHTML() {
    const t = (act, title, inner, extra) => `<button type="button" data-act="${act}" title="${title}" aria-label="${title}" ${extra || ''}>${inner}</button>`;
    return `
<div class="grp">
  ${t('theme', 'Açık tema', '<span class="sw light"></span>', 'class="themebtn" data-v="light"')}
  ${t('theme', 'Sepya tema', '<span class="sw sepia"></span>', 'class="themebtn" data-v="sepia"')}
  ${t('theme', 'Koyu tema', '<span class="sw dark"></span>', 'class="themebtn" data-v="dark"')}
  ${t('theme', 'Otomatik (site temasını izler)', '<span class="sw auto"></span>', 'class="themebtn" data-v="auto"')}
</div>
<div class="grp">
  <select data-act="font" title="Yazı tipi" aria-label="Yazı tipi">
    <option value="serif">Serif</option>
    <option value="sans">Sans</option>
    <option value="mono">Mono</option>
    <option value="dyslexia">Disleksi dostu</option>
  </select>
</div>
<div class="grp">
  ${t('size-', 'Yazıyı küçült', '<span class="txtbtn"><small>A</small>−</span>')}
  <span class="val" data-el="sizeVal" title="Yazı boyutu">20</span>
  ${t('size+', 'Yazıyı büyüt', '<span class="txtbtn">A+</span>')}
</div>
<div class="grp hide-sm">
  ${t('width', 'Dar sütun', svg(ICON.wNarrow), 'data-v="narrow"')}
  ${t('width', 'Normal sütun', svg(ICON.wNormal), 'data-v="normal"')}
  ${t('width', 'Geniş sütun', svg(ICON.wWide), 'data-v="wide"')}
</div>
<div class="grp">
  ${t('lh-', 'Satır aralığını azalt', svg(ICON.lhMinus))}
  ${t('lh+', 'Satır aralığını artır', svg(ICON.lhPlus))}
</div>
<div class="grp">
  ${t('tts-toggle', 'Sesli oku', svg(ICON.play), 'data-el="ttsBtn"')}
  ${t('tts-stop', 'Sesli okumayı durdur', svg(ICON.stop), 'data-el="ttsStop" disabled')}
  <select data-act="rate" title="Okuma hızı" aria-label="Okuma hızı">
    ${RATES.map(r => `<option value="${r}">${String(r).replace('.', ',')}×</option>`).join('')}
  </select>
</div>
<div class="grp">
  ${t('ruler', 'Odak cetveli', svg(ICON.ruler), 'data-el="rulerBtn" aria-pressed="false"')}
  ${t('print', 'Makaleyi yazdır', svg(ICON.print), 'class="hide-sm"')}
  ${t('copy', 'Metin olarak kopyala', svg(ICON.copy))}
</div>
<div class="spacer"></div>
<div class="grp">
  ${t('close', 'Okuma modunu kapat (Esc)', svg(ICON.close), 'class="close"')}
</div>`;
  }

  function buildUI(art) {
    const host = document.createElement('div');
    host.id = 'go-reader-host';
    host.setAttribute('style', 'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important; contain: strict !important;');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Okuma modu');
    root.lang = R.lang || '';
    root.innerHTML = `
<div class="scroller" tabindex="-1">
  <div class="progress"><i></i></div>
  <div class="ruler" aria-hidden="true"><div class="d top"></div><div class="band"></div><div class="d bot"></div></div>
  <div class="toolbar" role="toolbar" aria-label="Okuma araçları">${toolbarHTML()}</div>
  <article class="page">
    <header class="head">
      <div class="site"></div>
      <h1 class="title"></h1>
      <div class="meta"></div>
    </header>
    <div class="notice" hidden>Bu sayfada ana içerik net bulunamadı — sayfanın temizlenmiş metninin tamamı gösteriliyor.</div>
    <div class="content"></div>
  </article>
</div>
<div class="toast" role="status" aria-live="polite"></div>`;
    shadow.appendChild(root);

    const q = s => root.querySelector(s);
    const els = {
      root, scroller: q('.scroller'), bar: q('.progress > i'), ruler: q('.ruler'), toolbar: q('.toolbar'),
      title: q('h1.title'), site: q('.site'), meta: q('.meta'), notice: q('.notice'), content: q('.content'),
      toast: q('.toast'), font: q('select[data-act="font"]'), rate: q('select[data-act="rate"]'),
      sizeVal: q('[data-el="sizeVal"]'), ttsBtn: q('[data-el="ttsBtn"]'), ttsStop: q('[data-el="ttsStop"]'), rulerBtn: q('[data-el="rulerBtn"]')
    };

    els.site.textContent = art.site || '';
    els.site.hidden = !art.site;
    els.title.textContent = art.title;
    const mins = Math.max(1, Math.ceil(art.words / 220));
    const metaParts = [art.site, art.author, `${mins} dk okuma`].filter(Boolean);
    metaParts.forEach(p => { const s = document.createElement('span'); s.textContent = p; els.meta.appendChild(s); });
    els.notice.hidden = !!art.readable;
    const frag = document.importNode(art.contentEl, true);
    while (frag.firstChild) els.content.appendChild(frag.firstChild);
    els.content.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    els.content.querySelectorAll('img').forEach(img => {
      img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer-when-downgrade';
      img.addEventListener('error', () => img.remove(), { once: true });
    });

    // Olaylar
    els.toolbar.addEventListener('click', onToolbarClick);
    els.font.addEventListener('change', () => { prefs.font = els.font.value; applyPrefs(); savePrefs(); });
    els.rate.addEventListener('change', () => { prefs.ttsRate = +els.rate.value; applyPrefs(); savePrefs(); ttsRestartCurrent(); });
    els.scroller.addEventListener('scroll', onScroll, { passive: true });
    els.scroller.addEventListener('mousemove', onMouseMove, { passive: true });
    els.scroller.addEventListener('mouseleave', () => { if (prefs.ruler) els.ruler.classList.remove('on'); });
    els.scroller.addEventListener('mouseenter', () => { if (prefs.ruler) els.ruler.classList.add('on'); });
    // Sayfanın klavye kısayollarının okuma modunda tetiklenmesini engelle
    ['keydown', 'keyup', 'keypress'].forEach(ev => host.addEventListener(ev, e => { if (e.key !== 'Escape') e.stopPropagation(); }));

    R.host = host; R.shadow = shadow; R.els = els;
    return host;
  }

  function applyPrefs() {
    const e = R.els;
    if (!e.root) return;
    const th = effectiveTheme();
    e.root.classList.remove('t-light', 't-sepia', 't-dark');
    e.root.classList.add('t-' + th);
    e.root.style.setProperty('--font', FONTS[prefs.font] || FONTS.serif);
    e.root.style.setProperty('--size', prefs.size + 'px');
    e.root.style.setProperty('--lh', String(prefs.lineHeight));
    e.root.style.setProperty('--w', prefs.width + 'px');
    e.font.value = prefs.font;
    e.rate.value = String(prefs.ttsRate);
    e.sizeVal.textContent = prefs.size;
    e.toolbar.querySelectorAll('button[data-act="theme"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === prefs.theme)));
    e.toolbar.querySelectorAll('button[data-act="width"]').forEach(b => b.setAttribute('aria-pressed', String(WIDTHS[b.dataset.v] === +prefs.width)));
    setDisabled('size-', prefs.size <= 14); setDisabled('size+', prefs.size >= 32);
    setDisabled('lh-', prefs.lineHeight <= 1.3 + 1e-9); setDisabled('lh+', prefs.lineHeight >= 2.2 - 1e-9);
    e.rulerBtn.setAttribute('aria-pressed', String(!!prefs.ruler));
    e.ruler.classList.toggle('on', !!prefs.ruler);
    updateRulerSize();
    checkInversion();
  }

  function setDisabled(act, v) {
    const b = R.els.toolbar.querySelector(`button[data-act="${act}"]`);
    if (b) b.disabled = v;
  }

  function checkInversion() {
    if (!R.host) return;
    const f = isInverted() ? 'invert(1) hue-rotate(180deg)' : 'none';
    if (R.host.style.getPropertyValue('filter') !== f) R.host.style.setProperty('filter', f, 'important');
  }

  function onToolbarClick(ev) {
    const b = ev.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    switch (act) {
      case 'close': closeReader(); return;
      case 'theme': prefs.theme = b.dataset.v; break;
      case 'size-': prefs.size = clamp(prefs.size - 1, 14, 32); break;
      case 'size+': prefs.size = clamp(prefs.size + 1, 14, 32); break;
      case 'width': prefs.width = WIDTHS[b.dataset.v] || 720; break;
      case 'lh-': prefs.lineHeight = Math.round(clamp(prefs.lineHeight - 0.1, 1.3, 2.2) * 10) / 10; break;
      case 'lh+': prefs.lineHeight = Math.round(clamp(prefs.lineHeight + 0.1, 1.3, 2.2) * 10) / 10; break;
      case 'ruler': prefs.ruler = !prefs.ruler; break;
      case 'tts-toggle': ttsToggle(); return;
      case 'tts-stop': ttsStop(); return;
      case 'print': printArticle(); return;
      case 'copy': copyText(); return;
      default: return;
    }
    applyPrefs();
    savePrefs();
  }

  let rafPending = false;
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const s = R.els.scroller;
      if (!s) return;
      const max = s.scrollHeight - s.clientHeight;
      R.els.bar.style.transform = `scaleX(${max > 0 ? clamp(s.scrollTop / max, 0, 1) : 1})`;
    });
  }

  let mouseY = null;
  function updateRulerSize() {
    const e = R.els;
    if (!e.ruler) return;
    const h = Math.round(prefs.size * prefs.lineHeight * 3);
    e.ruler.style.setProperty('--rh', h + 'px');
    const y = mouseY == null ? window.innerHeight * 0.4 : mouseY;
    const top = clamp(y - h / 2, 0, Math.max(0, window.innerHeight - h));
    e.ruler.style.setProperty('--ry', top + 'px');
  }
  function onMouseMove(ev) {
    mouseY = ev.clientY;
    if (prefs.ruler) updateRulerSize();
  }

  function toast(msg) {
    const t = R.els.toast;
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }

  async function copyText() {
    const a = R.article;
    const body = (R.els.content.innerText || R.els.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    const txt = [a.title, [a.site, a.author].filter(Boolean).join(' · '), location.href, '', body].filter((x, i) => x || i === 3).join('\n');
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
        R.shadow.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e2) { ok = false; }
    }
    toast(ok ? 'Metin panoya kopyalandı' : 'Kopyalanamadı');
  }

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function printArticle() {
    const a = R.article;
    const clone = R.els.content.cloneNode(true);
    clone.querySelectorAll('.go-speaking').forEach(el => el.classList.remove('go-speaking'));
    clone.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));
    const mins = Math.max(1, Math.ceil(a.words / 220));
    const meta = [a.site, a.author, `${mins} dk okuma`].filter(Boolean).map(escapeHTML).join(' · ');
    const font = FONTS[prefs.font] || FONTS.serif;
    const html = `<!doctype html><html lang="${escapeHTML(R.lang || 'tr')}"><head><meta charset="utf-8"><title>${escapeHTML(a.title)}</title>
<style>
@page { margin: 18mm 16mm; }
body { font-family: ${font}; font-size: 11.5pt; line-height: 1.55; color: #111; background: #fff; margin: 0; }
article { max-width: 680px; margin: 0 auto; }
h1.t { font-size: 22pt; line-height: 1.2; margin: 0 0 6pt; }
.m { font: 9pt/1.4 system-ui, sans-serif; color: #555; margin-bottom: 18pt; padding-bottom: 8pt; border-bottom: 1px solid #ddd; }
.u { font: 8pt system-ui, sans-serif; color: #777; word-break: break-all; }
h2, h3, h4 { page-break-after: avoid; break-after: avoid; margin: 16pt 0 6pt; }
p, li, blockquote { orphans: 3; widows: 3; }
img { max-width: 100%; height: auto; display: block; margin: 10pt auto; page-break-inside: avoid; break-inside: avoid; }
figure { margin: 12pt 0; break-inside: avoid; } figcaption { font-size: 9pt; color: #555; text-align: center; }
blockquote { margin: 10pt 0; padding-left: 10pt; border-left: 2px solid #999; color: #333; font-style: italic; }
pre { font: 8.5pt/1.45 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; background: #f5f5f5; padding: 8pt; border-radius: 4pt; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
table { border-collapse: collapse; font-size: 9.5pt; margin: 10pt 0; } td, th { border: 1px solid #ccc; padding: 3pt 6pt; }
a { color: #111; text-decoration: underline; }
</style></head><body><article><h1 class="t">${escapeHTML(a.title)}</h1><div class="m">${meta}<div class="u">${escapeHTML(location.href)}</div></div>${clone.innerHTML}</article></body></html>`;

    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed!important;right:0!important;bottom:0!important;width:0!important;height:0!important;border:0!important;visibility:hidden!important;';
    document.documentElement.appendChild(ifr);
    const cleanup = () => setTimeout(() => ifr.remove(), 500);
    try {
      const d = ifr.contentDocument;
      d.open(); d.write(html); d.close();
      const imgs = Array.from(d.images);
      const waits = imgs.map(im => im.complete ? Promise.resolve() : new Promise(r => { im.onload = im.onerror = r; }));
      Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, 2000))]).then(() => {
        try {
          ifr.contentWindow.addEventListener('afterprint', cleanup, { once: true });
          ifr.contentWindow.focus();
          ifr.contentWindow.print();
        } catch (e) { toast('Yazdırma başlatılamadı'); }
        setTimeout(() => { if (ifr.isConnected) ifr.remove(); }, 60000);
      });
    } catch (e) {
      ifr.remove();
      toast('Yazdırma başlatılamadı');
    }
  }

  /* ---------------- Sesli okuma ---------------- */
  const TTS_BLOCKS = 'h1,h2,h3,h4,p,li,blockquote,pre,figcaption,dt,dd,th,td,caption';

  function synth() { return window.speechSynthesis || null; }

  function ttsBuildQueue() {
    const items = [];
    const add = (el, text) => chunkText(text).forEach(c => items.push({ el, text: c }));
    add(R.els.title, R.article.title);
    const blocks = Array.from(R.els.content.querySelectorAll(TTS_BLOCKS)).filter(el => !el.querySelector(TTS_BLOCKS));
    if (!blocks.length) add(R.els.content, R.els.content.textContent);
    blocks.forEach(el => { const t = norm(el.textContent); if (t) add(el, t); });
    tts.queue = items;
  }

  function pickVoice() {
    const s = synth();
    if (!s) return { voice: null, lang: '' };
    const voices = s.getVoices() || [];
    const docLang = (document.documentElement.lang || '').toLowerCase();
    const turkish = docLang.startsWith('tr') || looksTurkish(R.article && R.article.text);
    if (turkish) {
      const v = voices.find(v => /^tr/i.test(v.lang) && v.localService) || voices.find(v => /^tr/i.test(v.lang)) || null;
      return { voice: v, lang: 'tr-TR' };
    }
    if (docLang) {
      const base = docLang.split('-')[0];
      const v = voices.find(v => v.lang.toLowerCase() === docLang) || voices.find(v => v.lang.toLowerCase().startsWith(base)) || null;
      return { voice: v, lang: v ? v.lang : docLang };
    }
    return { voice: null, lang: '' };
  }

  function highlight(el) {
    if (tts.current === el) return;
    if (tts.current) tts.current.classList.remove('go-speaking');
    tts.current = el || null;
    if (el) {
      el.classList.add('go-speaking');
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    }
  }

  function speakNext() {
    const s = synth();
    if (!s || !R.open || !tts.playing) return;
    if (tts.idx >= tts.queue.length) { ttsStop(); return; }
    const item = tts.queue[tts.idx];
    highlight(item.el);
    const u = new SpeechSynthesisUtterance(item.text);
    const { voice, lang } = pickVoice();
    if (voice) u.voice = voice;
    if (lang) u.lang = lang;
    u.rate = +prefs.ttsRate || 1;
    const tk = tts.token;
    u.onend = () => { if (tk !== tts.token) return; tts.idx++; speakNext(); };
    u.onerror = e => {
      if (tk !== tts.token) return;
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      tts.idx++; speakNext();
    };
    s.speak(u);
  }

  function ttsStartFrom() {
    // Görünür alandaki ilk paragraftan başla
    const tbH = R.els.toolbar ? R.els.toolbar.getBoundingClientRect().bottom : 0;
    if (R.els.scroller.scrollTop < 40) return 0;
    for (let i = 0; i < tts.queue.length; i++) {
      const r = tts.queue[i].el.getBoundingClientRect();
      if (r.bottom > tbH + 8) return i;
    }
    return 0;
  }

  function ttsPlay() {
    const s = synth();
    if (!s) { toast('Tarayıcı sesli okumayı desteklemiyor'); return; }
    if (tts.playing) return;
    if (!tts.paused) {
      ttsBuildQueue();
      if (!tts.queue.length) { toast('Okunacak metin yok'); return; }
      tts.idx = ttsStartFrom();
    }
    tts.playing = true; tts.paused = false;
    const tk = ++tts.token;
    s.cancel();
    setTimeout(() => { if (tk === tts.token) speakNext(); }, 60);
    ttsUI();
  }

  function ttsPause() {
    const s = synth();
    if (!tts.playing) return;
    tts.token++;
    tts.playing = false; tts.paused = true;
    if (s) s.cancel(); // pause() Chrome'da güvenilmez; mevcut parçadan yeniden başlarız
    ttsUI();
  }

  function ttsStop() {
    const s = synth();
    tts.token++;
    const was = tts.playing || tts.paused;
    tts.playing = false; tts.paused = false; tts.idx = 0; tts.queue = [];
    if (s && was) s.cancel();
    highlight(null);
    ttsUI();
  }

  function ttsToggle() { if (tts.playing) ttsPause(); else ttsPlay(); }

  function ttsRestartCurrent() {
    const s = synth();
    if (!tts.playing || !s) return;
    const tk = ++tts.token;
    s.cancel();
    setTimeout(() => { if (tk === tts.token) speakNext(); }, 60);
  }

  function ttsUI() {
    const b = R.els.ttsBtn;
    if (!b) return;
    b.innerHTML = svg(tts.playing ? ICON.pause : ICON.play);
    const label = tts.playing ? 'Sesli okumayı duraklat' : (tts.paused ? 'Sesli okumayı sürdür' : 'Sesli oku');
    b.title = label; b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(tts.playing));
    R.els.ttsStop.disabled = !(tts.playing || tts.paused);
  }

  if (synth()) {
    try { synth().addEventListener('voiceschanged', () => { /* ses listesi hazır; pickVoice her parçada sorar */ }); } catch (e) { /* yok */ }
    try { synth().getVoices(); } catch (e) { /* yok */ }
  }

  /* ---------------- Aç / kapat ---------------- */
  function onKeyDown(e) {
    if (e.key === 'Escape' && R.open) {
      e.preventDefault();
      e.stopPropagation();
      closeReader();
    }
  }

  function computeLang(art) {
    const docLang = (document.documentElement.lang || '').trim();
    if (docLang) return docLang;
    return looksTurkish(art.text) ? 'tr' : '';
  }

  async function openReader() {
    if (R.open) return true;
    await ensurePrefs();
    if (R.open) return true;
    let art;
    try {
      art = extractArticle(document, location.href);
    } catch (e) {
      const inert = document.implementation.createHTMLDocument('');
      const div = inert.createElement('div');
      const p = inert.createElement('p');
      p.textContent = norm(document.body ? document.body.innerText : '');
      div.appendChild(p);
      art = Object.assign(getMeta(document, location.href), { contentEl: div, text: p.textContent, words: p.textContent.split(/\s+/).length, readable: false });
    }
    readableCache = { href: location.href, t: Date.now(), v: art.readable };
    R.article = art;
    R.lang = computeLang(art);
    R.lastFocus = document.activeElement;
    const host = buildUI(art);

    const html = document.documentElement, body = document.body;
    R.savedOverflow = {
      html: html.style.getPropertyValue('overflow'), htmlP: html.style.getPropertyPriority('overflow'),
      body: body ? body.style.getPropertyValue('overflow') : '', bodyP: body ? body.style.getPropertyPriority('overflow') : ''
    };
    html.style.setProperty('overflow', 'hidden', 'important');
    if (body) body.style.setProperty('overflow', 'hidden', 'important');

    html.appendChild(host);
    R.open = true;
    applyPrefs();
    ttsUI();
    onScroll();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', updateRulerSize, { passive: true });
    R.watchTimer = setInterval(() => {
      if (!R.open) return;
      if (!R.host.isConnected) { document.documentElement.appendChild(R.host); }
      checkInversion();
      if (prefs.theme === 'auto') {
        const th = effectiveTheme();
        if (!R.els.root.classList.contains('t-' + th)) applyPrefs();
      }
    }, 800);
    try { R.els.scroller.focus({ preventScroll: true }); } catch (e) { /* yok */ }
    return true;
  }

  function closeReader() {
    if (!R.open) return false;
    ttsStop();
    R.open = false;
    clearInterval(R.watchTimer);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', updateRulerSize);
    const html = document.documentElement, body = document.body;
    const so = R.savedOverflow || {};
    if (so.html) html.style.setProperty('overflow', so.html, so.htmlP); else html.style.removeProperty('overflow');
    if (body) { if (so.body) body.style.setProperty('overflow', so.body, so.bodyP); else body.style.removeProperty('overflow'); }
    const host = R.host;
    if (host) host.remove();
    R.host = null; R.shadow = null; R.els = {}; R.article = null; tts.current = null;
    try { if (R.lastFocus && R.lastFocus.focus) R.lastFocus.focus({ preventScroll: true }); } catch (e) { /* yok */ }
    R.lastFocus = null;
    return true;
  }

  function isReadable() {
    if (R.open && R.article) return !!R.article.readable;
    if (readableCache.href === location.href && Date.now() - readableCache.t < 15000) return readableCache.v;
    let v = false;
    try { v = !!extractArticle(document, location.href).readable; } catch (e) { v = false; }
    readableCache = { href: location.href, t: Date.now(), v };
    return v;
  }

  // Tema değişince (depolama üzerinden yayılır) tersine çevirmeyi ve otomatik temayı tekrar denetle
  try {
    chrome.storage.onChanged.addListener(() => {
      if (!R.open) return;
      setTimeout(() => { if (R.open) applyPrefs(); }, 50);
      setTimeout(() => { if (R.open) applyPrefs(); }, 400);
    });
  } catch (e) { /* bağlam yok */ }

  /* ---------------- Mesajlar ---------------- */
  const M = (GO && GO.MSG) || { TOGGLE_READER: 'GO_TOGGLE_READER', OPEN_READER: 'GO_OPEN_READER', GET_STATE: 'GO_GET_STATE', READER_TTS: 'GO_READER_TTS' };
  const hostOf = (GO && GO.hostOf) || (u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } });

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      switch (msg.type) {
        case M.TOGGLE_READER:
          if (R.open) { closeReader(); sendResponse({ open: false }); return false; }
          openReader().then(() => sendResponse({ open: R.open }), () => sendResponse({ open: false }));
          return true;
        case M.OPEN_READER:
          if (R.open) { sendResponse({ open: true }); return false; }
          openReader().then(() => sendResponse({ open: R.open }), () => sendResponse({ open: false }));
          return true;
        case M.GET_STATE:
          sendResponse({ host: hostOf(location.href), mode: siteMode(), readerOpen: R.open, readable: isReadable() });
          return false;
        case M.READER_TTS: {
          const action = msg.action;
          const run = () => {
            if (action === 'play') ttsPlay();
            else if (action === 'pause') ttsPause();
            else if (action === 'stop') ttsStop();
            else if (action === 'toggle') ttsToggle();
            else return { ok: false };
            return { ok: true, playing: tts.playing, paused: tts.paused };
          };
          if (!R.open && (action === 'play' || action === 'toggle')) {
            openReader().then(() => sendResponse(run()), () => sendResponse({ ok: false }));
            return true;
          }
          if (!R.open) { sendResponse({ ok: action === 'stop' || action === 'pause' }); return false; }
          sendResponse(run());
          return false;
        }
        default:
          return false;
      }
    });
  } catch (e) { /* uzantı bağlamı yok */ }

  // Sayfa kapanırken sesli okumayı kes
  window.addEventListener('pagehide', () => { if (tts.playing || tts.paused) { try { synth() && synth().cancel(); } catch (e) { /* yok */ } } });
})();
