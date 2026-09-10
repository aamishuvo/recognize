/*! Recognize Auto Liker — popup */
'use strict';

const SETTING_FIELDS = [
  'scrollAmount', 'scrollDelay', 'clickDelay', 'maxLikesPerRun', 'maxNoNewContentAttempts'
];

const $ = (id) => document.getElementById(id);
let activeTab = null;
let contentAvailable = false;
let poll = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  const { settings } = await chrome.storage.local.get('settings');
  applySettings(settings || {});

  SETTING_FIELDS.forEach((id) => $(id).addEventListener('change', saveSettings));
  $('start').addEventListener('click', () => command('START'));
  $('pause').addEventListener('click', () => command($('pause').dataset.mode === 'resume' ? 'RESUME' : 'PAUSE'));
  $('stop').addEventListener('click', () => command('STOP'));
  $('diagnose').addEventListener('click', runDiagnose);
  $('open-options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('reset-stats').addEventListener('click', async (e) => {
    e.preventDefault();
    if (activeTab) await chrome.storage.local.remove('status_' + activeTab.id);
    render(null);
  });

  await resolveTab();
  await refresh();
  poll = setInterval(refresh, 700);
  window.addEventListener('unload', () => clearInterval(poll));
}

function applySettings(s) {
  SETTING_FIELDS.forEach((id) => { if (s[id] != null) $(id).value = s[id]; });
}

async function saveSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...(settings || {}) };
  SETTING_FIELDS.forEach((id) => {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v)) next[id] = v;
  });
  // The popup exposes single base values; explicit min/max belong to Options.
  // Clearing them here keeps the derived ranges consistent with clickDelay.
  next.minClickDelay = null;
  next.maxClickDelay = null;
  await chrome.storage.local.set({ settings: next });
  if (contentAvailable) command('STATUS', next);
}

async function resolveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  const host = safeHost(tab && tab.url);
  const onRecognize = !!host && /(^|\.)recognizeapp\.com$/.test(host);
  $('page').textContent = onRecognize ? host : (host || 'no page');
  if (!onRecognize) {
    notice('Open your RecognizeApp feed tab, then reopen this popup. The extension only runs on recognizeapp.com.');
    setControlsEnabled(false);
  }
  return onRecognize;
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
}

function notice(text) {
  const el = $('notice');
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
}

function setControlsEnabled(on) {
  ['start', 'pause', 'stop', 'diagnose'].forEach((id) => { $(id).disabled = !on; });
}

function sendToTab(message) {
  return new Promise((resolve) => {
    if (!activeTab) { resolve(null); return; }
    chrome.tabs.sendMessage(activeTab.id, message, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }   // no content script
      resolve(response || null);
    });
  });
}

async function command(cmd, settingsOverride) {
  const { settings } = await chrome.storage.local.get('settings');
  const response = await sendToTab({
    type: 'RAL_COMMAND',
    command: cmd,
    settings: settingsOverride || settings || {}
  });
  if (!response) {
    contentAvailable = false;
    notice('Could not reach the page. Reload the Recognize tab, then try again.');
    setControlsEnabled(false);
    return;
  }
  contentAvailable = true;
  render(response.status);
}

async function refresh() {
  const response = await sendToTab({ type: 'RAL_COMMAND', command: 'STATUS' });
  if (response && response.status) {
    contentAvailable = true;
    notice(null);
    render(response.status);
    return;
  }
  // Content script unreachable (tab throttled, still loading, or wrong page):
  // fall back to whatever the service worker last cached for this tab.
  const cached = activeTab
    ? await chrome.runtime.sendMessage({ type: 'RAL_GET_CACHED_STATUS', tabId: activeTab.id })
    : null;
  if (cached) { render(cached); return; }
  if (await resolveTab()) notice('Waiting for the Recognize page to finish loading…');
}

function render(status) {
  const state = (status && status.state) || 'STOPPED';
  const stats = (status && status.stats) || {};
  $('dot').className = 'dot ' + state;
  $('state').textContent = status && status.stalled ? state + ' (throttled)' : state;
  $('s-scanned').textContent = stats.scanned || 0;
  $('s-already').textContent = stats.alreadyLiked || 0;
  $('s-liked').textContent = stats.newLikes || 0;
  $('s-skipped').textContent = stats.skipped || 0;
  $('s-errors').textContent = stats.errors || 0;
  $('current').textContent = stats.currentRecognitionId || '—';

  const running = state === 'RUNNING' || state === 'WAITING';
  const paused = state === 'PAUSED';
  setControlsEnabled(true);
  $('start').disabled = running || paused;
  $('pause').disabled = !running && !paused;
  $('pause').textContent = paused ? 'RESUME' : 'PAUSE';
  $('pause').dataset.mode = paused ? 'resume' : 'pause';
  $('stop').disabled = state === 'STOPPED';

  if (status && status.stalled) {
    notice('Chrome has throttled this background tab, so progress is slow. Bring the tab forward to speed it up.');
  }
}

async function runDiagnose() {
  const response = await sendToTab({ type: 'RAL_COMMAND', command: 'DIAGNOSE' });
  if (!response || !response.report) {
    notice('Diagnostic failed — reload the Recognize tab and try again.');
    return;
  }
  const r = response.report;
  notice(`Diagnostic: ${r.unlikedCount} unliked, ${r.likedCount} already liked. Container ${r.scrollContainer}. Full report in the page console (F12).`);
  render(response.status);
}
