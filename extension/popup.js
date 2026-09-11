/*! Recognize Auto Liker — popup */
'use strict';

const SETTING_FIELDS = [
  'scrollAmount', 'scrollDelay', 'clickDelay', 'maxLikesPerRun', 'maxNoNewContentAttempts',
  'stopAfterConsecutiveAlreadyLiked', 'stopAfterEmptyPages', 'startAtPage'
];
const BOOL_FIELDS = ['keepAwakeInBackground', 'pageMode'];

const $ = (id) => document.getElementById(id);
let activeTab = null;
let contentAvailable = false;
let poll = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  const { settings } = await chrome.storage.local.get('settings');
  applySettings(settings || {});

  [...SETTING_FIELDS, ...BOOL_FIELDS].forEach((id) => $(id).addEventListener('change', saveSettings));
  $('start').addEventListener('click', () => command('START'));
  $('pause').addEventListener('click', () => command($('pause').dataset.mode === 'resume' ? 'RESUME' : 'PAUSE'));
  $('stop').addEventListener('click', () => command('STOP'));
  $('diagnose').addEventListener('click', runDiagnose);
  $('resume').addEventListener('click', async () => {
    const page = parseInt($('resume').dataset.page, 10);
    if (Number.isFinite(page)) {
      $('startAtPage').value = page;
      await saveSettings();
    }
    command('START');
  });
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
  if (s.startAtPage == null) $('startAtPage').value = '';
  $('keepAwakeInBackground').checked = s.keepAwakeInBackground !== false;
  $('pageMode').checked = s.pageMode !== false;
}

async function saveSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...(settings || {}) };
  SETTING_FIELDS.forEach((id) => {
    const raw = $(id).value.trim();
    const v = parseInt(raw, 10);
    // A blank "start from page" means "begin wherever the browser already is".
    if (id === 'startAtPage' && raw === '') next[id] = null;
    else if (Number.isFinite(v)) next[id] = v;
  });
  BOOL_FIELDS.forEach((id) => { next[id] = $(id).checked; });
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
  renderKeepAlive(status && status.keepAlive, running || paused);
  renderPageProgress(status);

  // A per-page PAGE_DONE from the engine tells a person nothing. When a
  // paginated run exists, ITS reason is the one worth showing.
  const run = status && status.pageRun;
  const engineReason = status && status.lastResult && status.lastResult.reason;
  if (state === 'STOPPED') {
    if (run && !run.active && run.lastReason) {
      notice(explainPageStop(run, status && status.pagination));
    } else if (engineReason && engineReason !== 'PAGE_DONE') {
      notice(explainStop(engineReason, stats));
    }
  }
}

/** Page-by-page progress, and a one-click continue from where it got to. */
function renderPageProgress(status) {
  const row = $('page-row');
  const resumeBtn = $('resume');
  const info = status && status.pagination;
  const run = status && status.pageRun;

  if (!info || !info.paginated) {
    row.hidden = true;
    resumeBtn.hidden = true;
    return;
  }
  row.hidden = false;
  const where = info.last ? `${info.current} of ${info.last}` : `${info.current}`;
  $('page-info').textContent = run && run.active
    ? `${where} · ${run.totals.newLikes} liked over ${run.pagesDone} page(s)`
    : where;

  const resumeAt = run && !run.active ? run.resumeAt : null;
  if (resumeAt && resumeAt !== info.current) {
    resumeBtn.hidden = false;
    resumeBtn.dataset.page = resumeAt;
    resumeBtn.textContent = `Resume from page ${resumeAt}`;
  } else {
    resumeBtn.hidden = true;
  }
}

function explainPageStop(run, info) {
  const done = `${run.pagesDone || 0} page(s), ${run.totals ? run.totals.newLikes : 0} new like(s).`;
  switch (run.lastReason) {
    case 'NO_PAGINATION':
      return `Stopped: that page had no pagination, so there was nowhere to go next. Open the grid view that shows page links at the bottom, then start again. (${done})`;
    case 'END_OF_FEED':
      return `Reached the last page${info && info.last ? ` (${info.last})` : ''}. ${done}`;
    case 'CAUGHT_UP':
      return `Caught up — several pages in a row had nothing new. ${done}`;
    case 'MAX_LIKES_REACHED':
      return `Hit the maximum new likes for this run. ${done} Press Resume to carry on.`;
    case 'STOPPED_BY_USER':
      return `Stopped by you after ${done}`;
    default:
      return `Run ended: ${run.lastReason}. ${done}`;
  }
}

/** Say plainly why the last run ended, so a surprising stop is not a mystery. */
function explainStop(reason, stats) {
  switch (reason) {
    case 'CAUGHT_UP':
      return 'Caught up — a long run of already-liked posts means everything below is older, so it stopped instead of re-walking the feed.';
    case 'MAX_LIKES_REACHED':
      return `Reached the maximum of ${stats.newLikes || 0} new likes for this run. Raise "Maximum new likes" to go further.`;
    case 'END_OF_FEED':
      return 'Reached the end of the feed — no new posts loaded after several attempts. If you think there is more below, raise "Scroll delay" and "Stop after no new posts".';
    case 'STOPPED_BY_USER':
      return 'Stopped by you.';
    case 'ERROR':
      return 'The run hit an error and stopped. Open the page console (F12) for the details.';
    default:
      return `Last run ended: ${reason}`;
  }
}

function renderKeepAlive(ka, active) {
  const hint = $('keepalive-hint');
  if (!ka || !active || !$('keepAwakeInBackground').checked) { hint.hidden = true; return; }
  hint.hidden = false;
  if (!ka.supported) {
    hint.textContent = 'Keep-awake unavailable in this browser; a background tab will run slowly.';
  } else if (ka.audioState === 'suspended') {
    hint.textContent = 'Click once anywhere on the Recognize page to arm keep-awake.';
  } else if (ka.active && ka.audioState === 'running') {
    hint.textContent = 'Keep-awake on — this tab shows a speaker icon while it runs.';
  } else {
    hint.textContent = 'Keep-awake starting…';
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
