/*!
 * Recognize Auto Liker — content script (Chrome glue)
 * ---------------------------------------------------------------------------
 * Owns everything chrome.* so that engine.js stays a pure DOM module.
 *
 *   - loads settings + history from chrome.storage.local
 *   - relays START / PAUSE / RESUME / STOP / STATUS / DIAGNOSE from the popup
 *   - pushes status up to the service worker (which survives popup closes)
 *   - draws the on-page STOP badge
 *   - Esc = emergency stop
 *
 * It never reads cookies, tokens or credentials, and never talks to any server.
 */
(function () {
  'use strict';

  var RAL = window.RecognizeAutoLiker;
  if (!RAL) { console.error('[RecognizeAutoLiker] engine.js failed to load'); return; }
  if (window.__ralContentLoaded) return;
  window.__ralContentLoaded = true;

  var HISTORY_KEY = 'history';
  var SETTINGS_KEY = 'settings';
  var HISTORY_LIMIT = 5000;

  var historyMap = Object.create(null);   // id -> { outcome, failures, t }
  var historyDirty = false;
  var engine = null;
  var badge = null;
  var badgeEls = {};

  /* ------------------------------------------------------------- history */
  /**
   * Bookkeeping and optimisation ONLY. It can make the engine skip an item
   * that has failed repeatedly; it can never make it click. Whether a
   * recognition is liked is decided by the DOM, every single time.
   */
  var history = {
    has: function (id) { return Object.prototype.hasOwnProperty.call(historyMap, id); },
    get: function (id) { return historyMap[id] || null; },
    add: function (id, outcome) {
      var rec = historyMap[id] || { failures: 0 };
      rec.outcome = outcome;
      rec.t = Date.now();
      if (outcome === 'failed') rec.failures = (rec.failures || 0) + 1;
      historyMap[id] = rec;
      historyDirty = true;
    }
  };

  function loadState() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([SETTINGS_KEY, HISTORY_KEY], function (data) {
        if (chrome.runtime.lastError) { resolve({}); return; }
        historyMap = (data && data[HISTORY_KEY]) || Object.create(null);
        resolve((data && data[SETTINGS_KEY]) || {});
      });
    });
  }

  function flushHistory() {
    if (!historyDirty) return;
    historyDirty = false;
    var ids = Object.keys(historyMap);
    if (ids.length > HISTORY_LIMIT) {                    // prune oldest first
      ids.sort(function (a, b) { return (historyMap[a].t || 0) - (historyMap[b].t || 0); });
      ids.slice(0, ids.length - HISTORY_LIMIT).forEach(function (id) { delete historyMap[id]; });
    }
    try { chrome.storage.local.set({ history: historyMap }); } catch (e) {}
  }
  setInterval(flushHistory, 5000);
  window.addEventListener('pagehide', function () {
    flushHistory();
    if (keepAlive && keepAlive.status().active) keepAlive.stop();
  });

  /* -------------------------------------------------------------- engine */
  function ensureEngine(settings) {
    if (engine) {
      if (settings) engine.updateSettings(settings);
      return engine;
    }
    engine = RAL.createEngine({
      settings: settings || {},
      history: history,
      onUpdate: onEngineUpdate
    });
    return engine;
  }

  var keepAlive = window.__ralKeepAlive || null;
  var keepAliveWanted = false;

  /* ------------------------------------------------------ paginated runs */
  var PAGES = window.RecognizePagination || null;
  var pageRunner = null;
  var pageState = null;

  function pageStorage() {
    return {
      get: function () {
        return new Promise(function (resolve) {
          chrome.storage.local.get(PAGES.STATE_KEY, function (d) {
            resolve((d && d[PAGES.STATE_KEY]) || null);
          });
        });
      },
      set: function (state) {
        return new Promise(function (resolve) {
          var payload = {};
          payload[PAGES.STATE_KEY] = state;
          chrome.storage.local.set(payload, function () { resolve(); });
        });
      }
    };
  }

  function ensurePageRunner(settings) {
    if (pageRunner) return pageRunner;
    pageRunner = PAGES.createPageRunner({
      doc: document,
      win: window,
      storage: pageStorage(),
      navigate: function (url) {
        flushHistory();
        // A real navigation: this content script is about to be torn down, and
        // the next page's copy picks the run back up from storage.
        location.href = url;
      },
      countUnliked: function () {
        return document.querySelectorAll(RAL.SELECTORS.UNLIKED).length;
      },
      runEngine: function (pageSettings) {
        var eng = ensureEngine(Object.assign({}, settings, pageSettings));
        eng.updateSettings(pageSettings);
        keepAliveWanted = settings.keepAwakeInBackground !== false;
        return eng.start(pageSettings);
      },
      onUpdate: function (state) {
        pageState = state;
        pushStatus(engine ? engine.snapshot() : null);
      },
      log: function (m) { if (settings && settings.debug) console.log('[RecognizeAutoLiker] ' + m); }
    });
    return pageRunner;
  }

  /** Hold the tab awake only while a run is actually in progress. */
  function syncKeepAlive(state) {
    if (!keepAlive) return;
    var running = state === 'RUNNING' || state === 'WAITING' || state === 'PAUSED';
    if (keepAliveWanted && running) {
      if (!keepAlive.status().active) keepAlive.start();
    } else if (keepAlive.status().active) {
      keepAlive.stop();
    }
  }

  var lastPush = 0;
  var pushTimer = null;

  function onEngineUpdate(snap) {
    syncKeepAlive(snap.state);
    renderBadge(snap);
    var now = Date.now();
    if (now - lastPush > 400) {
      lastPush = now;
      pushStatus(snap);
    } else if (!pushTimer) {
      pushTimer = setTimeout(function () {
        pushTimer = null;
        lastPush = Date.now();
        pushStatus(engine ? engine.snapshot() : null);
      }, 400);
    }
  }

  function pushStatus(snap) {
    if (!snap) return;
    try {
      chrome.runtime.sendMessage({ type: 'RAL_STATUS', payload: statusPayload(snap) }, function () {
        void chrome.runtime.lastError;   // service worker asleep: not an error
      });
    } catch (e) { /* extension context invalidated (reloaded) */ }
  }

  function statusPayload(snap) {
    return {
      available: true,
      state: snap.state,
      stats: snap.stats,
      settings: snap.settings,
      lastResult: snap.lastResult,
      keepAlive: keepAlive ? keepAlive.status() : { supported: false, active: false },
      pagination: PAGES ? PAGES.parsePageInfo(document, window) : null,
      pageRun: pageState,
      url: location.href,
      updatedAt: Date.now()
    };
  }

  /* ------------------------------------------------------------- badge UI */
  function buildBadge() {
    if (badge) return;
    badge = document.createElement('div');
    badge.id = 'ral-badge-host';
    var shadow = badge.attachShadow ? badge.attachShadow({ mode: 'open' }) : badge;
    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '.b{font:12px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#161b26;color:#e9edf5;',
      'border:1px solid #333d54;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.4);',
      'padding:9px 11px;min-width:168px;}',
      '.r{display:flex;align-items:center;gap:7px;font-weight:700;margin-bottom:6px;}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#8b93a7;}',
      '.dot.RUNNING,.dot.WAITING{background:#3ddc84;} .dot.PAUSED{background:#ffc857;}',
      '.dot.ERROR{background:#ff6b6b;}',
      '.n{display:flex;justify-content:space-between;opacity:.8;font-size:11px;}',
      'button{margin-top:7px;width:100%;padding:5px;border:0;border-radius:6px;background:#a03a3a;',
      'color:#fff;font:inherit;font-weight:700;cursor:pointer;}',
      'button:hover{filter:brightness(1.15);}',
      '.h{margin-top:5px;font-size:10px;opacity:.5;text-align:center;}'
    ].join('');
    var wrap = document.createElement('div');
    wrap.className = 'b';
    wrap.innerHTML =
      '<div class="r"><span class="dot" id="d"></span><span id="s">STOPPED</span></div>' +
      '<div class="n"><span>New likes</span><span id="l">0</span></div>' +
      '<div class="n"><span>Already liked</span><span id="a">0</span></div>' +
      '<div class="n"><span>Page</span><span id="p">&ndash;</span></div>' +
      '<button id="x">STOP</button>' +
      '<div class="h">Esc = emergency stop</div>';
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(badge);

    var q = function (id) { return shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector('#' + id); };
    badgeEls = { dot: q('d'), state: q('s'), likes: q('l'), already: q('a'), page: q('p'), stop: q('x') };
    badgeEls.stop.addEventListener('click', function () {
      if (engine) engine.stop('on-page STOP button');
    });
  }

  function renderBadge(snap) {
    var showBadge = snap.settings && snap.settings.showBadge !== false;
    var active = snap.state !== 'STOPPED';
    if (!active || !showBadge) { if (badge) badge.style.display = 'none'; return; }
    buildBadge();
    badge.style.display = '';
    badgeEls.dot.className = 'dot ' + snap.state;
    badgeEls.state.textContent = snap.state;
    badgeEls.likes.textContent = snap.stats.newLikes;
    badgeEls.already.textContent = snap.stats.alreadyLiked;
    // On the page itself, so the number is readable even if the tab locks up
    // and the popup will not open.
    if (badgeEls.page) {
      var info = PAGES ? PAGES.parsePageInfo(document, window) : null;
      badgeEls.page.textContent = info && info.paginated
        ? String(info.current) + (info.last ? ' / ' + info.last : '')
        : '–';
    }
  }

  /* ------------------------------------------------------- emergency stop */
  // Capture phase so the page cannot swallow it first.
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      if (engine && engine.getState() !== 'STOPPED') {
        engine.stop('Esc emergency stop');
        flushHistory();
      }
    }
  }, true);

  /* ------------------------------------------------------------ messaging */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // The service worker is not throttled the way a background tab is, so it
    // pings us on an alarm. We settle any wait Chrome already owed us, which
    // keeps a backgrounded run moving without changing click pacing.
    if (msg && msg.type === 'RAL_TICK') {
      var result = engine ? engine.nudge() : { caughtUp: 0, overdueBy: 0, pending: 0 };
      sendResponse({
        ok: true,
        state: engine ? engine.getState() : 'STOPPED',
        nudged: result.caughtUp,
        overdueBy: result.overdueBy
      });
      return true;
    }

    if (!msg || msg.type !== 'RAL_COMMAND') return false;

    loadState().then(function (stored) {
      var settings = Object.assign({}, stored, msg.settings || {});
      var eng = ensureEngine(settings);
      keepAliveWanted = settings.keepAwakeInBackground !== false;

      switch (msg.command) {
        case 'START':
          if (PAGES && settings.pageMode !== false && PAGES.parsePageInfo(document, window).paginated) {
            // Real pagination beats infinite scrolling: small fresh pages, and
            // progress that survives a reload.
            ensurePageRunner(settings).start(settings);
          } else {
            eng.start(settings);
          }
          syncKeepAlive(eng.getState());
          break;

        case 'FIND_START':
          if (PAGES && PAGES.parsePageInfo(document, window).paginated) {
            ensurePageRunner(settings).findStart(settings);
          } else {
            eng.start(settings);
          }
          syncKeepAlive(eng.getState());
          break;
        case 'PAUSE':
          eng.pause();
          break;
        case 'RESUME':
          eng.resume();
          break;
        case 'STOP':
          eng.stop('popup STOP');
          if (pageRunner) pageRunner.stop('STOPPED_BY_USER');
          else if (PAGES) pageStorage().get().then(function (st) {
            if (st && st.active) { st.active = false; st.lastReason = 'STOPPED_BY_USER'; pageStorage().set(st); }
          });
          syncKeepAlive('STOPPED');
          flushHistory();
          break;
        case 'DIAGNOSE':
          sendResponse({ ok: true, report: eng.diagnose(), status: statusPayload(eng.snapshot()) });
          return;
        case 'STATUS':
        default:
          break;
      }
      sendResponse({ ok: true, status: statusPayload(eng.snapshot()) });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    });

    return true;   // async sendResponse
  });

  /* ----------------------------------------------------------------- boot */
  // NOTE: we deliberately never consult document.hidden or visibilityState.
  // A backgrounded or minimised tab keeps working (subject to Chrome's own
  // timer throttling — see README, "Important limitation").
  loadState().then(function (stored) {
    ensureEngine(stored);
    pushStatus(engine.snapshot());
    if (stored && stored.debug) console.log('[RecognizeAutoLiker] content script ready on ' + location.host);

    // If a paginated run was in progress when the last page navigated away,
    // pick it straight back up. Give the grid a moment to render first.
    if (!PAGES) return;
    pageStorage().get().then(function (state) {
      if (!state || !state.active) return;
      pageState = state;
      setTimeout(function () {
        ensurePageRunner(Object.assign({}, stored, state.settings || {})).resume();
      }, 1200);
    });
  });
})();
