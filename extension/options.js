/*! Recognize Auto Liker — options page */
'use strict';

const NUMBER_FIELDS = [
  'scrollAmount', 'scrollDelay', 'maxNoNewContentAttempts',
  'clickDelay', 'verifyTimeout', 'maxLikesPerRun', 'historyFailureLimit'
];
const NULLABLE_FIELDS = ['minClickDelay', 'maxClickDelay'];
const BOOL_FIELDS = ['showBadge', 'debug'];

const $ = (id) => document.getElementById(id);
let defaults = {};

document.addEventListener('DOMContentLoaded', async () => {
  defaults = await chrome.runtime.sendMessage({ type: 'RAL_GET_DEFAULTS' });
  await load();

  [...NUMBER_FIELDS, ...NULLABLE_FIELDS, ...BOOL_FIELDS].forEach((id) => {
    $(id).addEventListener('change', save);
  });
  $('clear-history').addEventListener('click', clearHistory);
  $('restore-defaults').addEventListener('click', restoreDefaults);
});

async function load() {
  const { settings, history } = await chrome.storage.local.get(['settings', 'history']);
  const s = { ...defaults, ...(settings || {}) };
  NUMBER_FIELDS.forEach((id) => { $(id).value = s[id] ?? ''; });
  NULLABLE_FIELDS.forEach((id) => { $(id).value = s[id] == null ? '' : s[id]; });
  BOOL_FIELDS.forEach((id) => { $(id).checked = s[id] !== false && s[id] !== undefined ? !!s[id] : false; });
  $('showBadge').checked = s.showBadge !== false;
  showHistoryCount(history);
}

function showHistoryCount(history) {
  const n = history ? Object.keys(history).length : 0;
  $('history-count').textContent = `Stored recognitions: ${n}`;
}

async function save() {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...defaults, ...(settings || {}) };

  NUMBER_FIELDS.forEach((id) => {
    const v = parseInt($(id).value, 10);
    if (Number.isFinite(v)) next[id] = v;
  });
  NULLABLE_FIELDS.forEach((id) => {
    const raw = $(id).value.trim();
    const v = parseInt(raw, 10);
    next[id] = raw === '' || !Number.isFinite(v) ? null : v;   // blank = derive from clickDelay
  });
  BOOL_FIELDS.forEach((id) => { next[id] = $(id).checked; });

  await chrome.storage.local.set({ settings: next });
  flash('Saved.');
}

async function clearHistory() {
  await chrome.storage.local.set({ history: {} });
  showHistoryCount({});
  flash('History cleared. Liked state is still read from the page, so nothing was lost.');
}

async function restoreDefaults() {
  await chrome.storage.local.set({ settings: { ...defaults } });
  await load();
  flash('Defaults restored.');
}

let flashTimer = null;
function flash(text) {
  const el = $('saved');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 2500);
}
