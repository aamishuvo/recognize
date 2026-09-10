/*!
 * Recognize Auto Liker — MV3 service worker
 * ---------------------------------------------------------------------------
 * Deliberately does NO DOM automation: a service worker cannot touch the
 * Recognize page, and MV3 suspends it freely. It only:
 *   - seeds default settings on install
 *   - caches the last status from each tab so the popup has something to show
 *     immediately (and after the worker itself has been suspended and revived)
 *   - runs a low-frequency alarm that persists status and flags a stalled run
 *
 * All persistent state lives in chrome.storage.local, so a suspended worker
 * loses nothing.
 */
'use strict';

const DEFAULT_SETTINGS = {
  scrollAmount: 700,
  scrollDelay: 1500,
  clickDelay: 1200,
  maxLikesPerRun: 100,
  maxNoNewContentAttempts: 5,
  minClickDelay: null,
  maxClickDelay: null,
  verifyTimeout: 3000,
  historyFailureLimit: 3,
  showBadge: true,
  debug: false
};

const WATCHDOG_ALARM = 'ral-watchdog';
const STALL_AFTER_MS = 120000;   // 2 min with no progress => report as stalled

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
});

/** Content scripts push status here; we cache it per tab. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'RAL_STATUS' && sender.tab) {
    const key = 'status_' + sender.tab.id;
    chrome.storage.local.set({ [key]: { ...msg.payload, tabId: sender.tab.id } });
    return false;
  }

  if (msg.type === 'RAL_GET_CACHED_STATUS') {
    chrome.storage.local.get('status_' + msg.tabId).then((data) => {
      sendResponse(data['status_' + msg.tabId] || null);
    });
    return true;
  }

  if (msg.type === 'RAL_GET_DEFAULTS') {
    sendResponse(DEFAULT_SETTINGS);
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove('status_' + tabId);
});

/**
 * Watchdog. It cannot make a throttled tab run faster — nothing can, and we do
 * not try to defeat Chrome's throttling. It notices that a run has stopped
 * making progress and records that, so the popup can tell the truth instead of
 * showing a stale "RUNNING".
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const updates = {};

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('status_') || !value || typeof value !== 'object') continue;
    const active = value.state === 'RUNNING' || value.state === 'WAITING';
    const stalled = active && now - (value.updatedAt || 0) > STALL_AFTER_MS;
    if (stalled !== !!value.stalled) updates[key] = { ...value, stalled };
  }

  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
});
