/* Gece Okuru — service worker */
importScripts('shared/common.js');

const BADGE = { off: '', dark: 'GCE', sepia: 'SPY', light: 'GÜN', custom: 'ÖZL' };
const BADGE_COLOR = { dark: '#2b3a67', sepia: '#8a6a3b', light: '#c98a1e', custom: '#4a5a7a' };

function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (e) { return null; }
}

/* İçerik betiğine mesaj gönder; yoksa enjekte edip tekrar dene. */
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['shared/common.js', 'content/theme.js', 'content/reader.js']
      });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      console.warn('Gece Okuru: sekmeye ulaşılamadı', e2 && e2.message);
      return null;
    }
  }
}

async function updateBadge(tab) {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  try {
    if (!isWebUrl(tab.url)) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      return;
    }
    const data = await GO.getAll();
    const eff = GO.effectiveFor(GO.hostOf(tab.url), data);
    const text = BADGE[eff.mode] || '';
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: BADGE_COLOR[eff.mode] || '#2b3a67' });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId: tab.id, color: '#ffffff' });
      }
    }
  } catch (e) { /* sekme kapanmış olabilir */ }
}

async function updateAllBadges() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(tabs.map(updateBadge));
  } catch (e) { /* yoksay */ }
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'go-reader', title: 'Okuma modunu aç', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'go-toggle', title: 'Bu sitede temayı aç/kapat', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'go-options', title: 'Ayarlar', contexts: ['page', 'selection', 'action'] });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const cur = await chrome.storage.sync.get(['settings', 'sites']);
    const patch = {};
    if (!cur.settings) patch.settings = GO.clone(GO.DEFAULTS.settings);
    if (!cur.sites) patch.sites = {};
    if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  } catch (e) { console.warn('Gece Okuru: varsayılanlar yazılamadı', e); }
  createMenus();
  updateAllBadges();
});

chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => { createMenus(); updateAllBadges(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'go-options') { chrome.runtime.openOptionsPage(); return; }
  if (!tab || !isWebUrl(tab.url)) return;
  if (info.menuItemId === 'go-reader') {
    await sendToTab(tab.id, { type: GO.MSG.OPEN_READER });
  } else if (info.menuItemId === 'go-toggle') {
    await GO.toggleSite(GO.hostOf(tab.url));
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab || !isWebUrl(tab.url)) return;
  const host = GO.hostOf(tab.url);
  if (!host) return;
  if (command === 'toggle-dark') await GO.toggleSite(host);
  else if (command === 'toggle-reader') await sendToTab(tab.id, { type: GO.MSG.TOGGLE_READER });
  else if (command === 'cycle-mode') await GO.cycleSite(host);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { updateBadge(await chrome.tabs.get(tabId)); } catch (e) { /* yoksay */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') updateBadge(tab);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.settings || changes.sites)) updateAllBadges();
});

// Zamanlamalı mod için rozeti dakikada bir tazele (alarm izni yok; SW uyanıkken çalışır)
setInterval(updateAllBadges, 60 * 1000);
