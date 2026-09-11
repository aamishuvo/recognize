// ==UserScript==
// @name         Recognize Auto Liker
// @namespace    local.recognize.autoliker
// @version      2.0.0
// @description  Likes RecognizeApp recognitions you have not liked yet. Never removes an existing like.
// @author       local
// @match        https://*.recognizeapp.com/*
// @match        https://recognizeapp.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/* GENERATED FILE — do not edit.
   Sources: extension/content/engine.js + src/standalone-panel.js
   Rebuild: node tools/build.cjs */
/*!
 * Recognize Auto Liker — automation engine
 * ---------------------------------------------------------------------------
 * Pure DOM automation. Contains NO chrome.* API calls, so the identical file
 * powers the Chrome extension, the standalone userscript/bookmarklet builds,
 * and the browser-based test runner. One engine means ONE safety gate.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * Clicking an approval control that is already `approved` / `data-method=delete`
 * sends the DELETE and REMOVES the user's own like. That must never happen.
 * A new like is dispatched ONLY for:
 *
 *   a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]
 *
 * The visible "+N" is the TOTAL from all users and is NEVER read for any
 * decision — an unliked post can show "+4" and a liked one "+5".
 *
 * Nothing here touches credentials, cookies, tokens or storage. It clicks the
 * page's own anchors and lets the site perform its normal action.
 */
(function (global) {
  'use strict';

  var VERSION = '2.0.0';

  /* ===================================================================== */
  /* SELECTORS                                                             */
  /* ===================================================================== */
  var SELECTORS = {
    /** The ONLY thing that is ever clicked. */
    UNLIKED: 'a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]',
    /** Liked by the current user. Counted, NEVER clicked (it would DELETE). */
    LIKED: 'a.approval_link.approved[data-category="recognition"][data-event="liked"][data-method="delete"]',
    /** Either state — diagnostics, counting and post-click verification. */
    ANY: 'a.approval_link[data-category="recognition"][data-event="liked"]'
  };

  // /banglalink.net/recognitions/rglauokd/approvals?approvers_limit=5
  //                              ^^^^^^^^ recognition id
  var RECOGNITION_HREF_RE = /\/recognitions\/([A-Za-z0-9_-]+)\/approvals(?:\/|\?|$)/;
  var APPROVAL_ID_RE = /\/approvals\/(\d+)/;
  var SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

  var STATE = {
    STOPPED: 'STOPPED',
    RUNNING: 'RUNNING',
    WAITING: 'WAITING',
    PAUSED: 'PAUSED',
    ERROR: 'ERROR'
  };

  var STOP_REASON = {
    USER: 'STOPPED_BY_USER',
    MAX_LIKES: 'MAX_LIKES_REACHED',
    END_OF_FEED: 'END_OF_FEED',
    CAUGHT_UP: 'CAUGHT_UP',
    ERROR: 'ERROR'
  };

  /* ===================================================================== */
  /* SETTINGS                                                              */
  /* ===================================================================== */
  var DEFAULT_SETTINGS = {
    scrollAmount: 700,              // px per scroll step; <=0 uses 60-75% of feed height
    scrollDelay: 1500,              // base wait after scrolling
    clickDelay: 1200,               // base click delay
    maxLikesPerRun: 100,
    maxNoNewContentAttempts: 5,
    /*
     * THE ANSWER TO "I ALREADY LIKED 1500 POSTS AND HAVE TO RELOAD THEM ALL".
     * A recognition feed is newest-first, so everything new is at the TOP and
     * everything below a long run of already-liked posts is older and already
     * handled. Once this many already-liked recognitions are met back to back
     * with nothing new in between, the run stops: the feed is caught up.
     * 0 disables it and walks the whole feed as before.
     */
    stopAfterConsecutiveAlreadyLiked: 40,
    /*
     * When a stretch of feed has nothing to like there is no reason to crawl it
     * at click pace. Fast-forward scrolls further per step and waits only as
     * long as new cards need to appear. It changes SCROLLING only - clicks keep
     * their full randomised pacing and the safety gate is untouched.
     */
    fastForward: true,
    fastForwardAfter: 2,        // scans with nothing to like before speeding up
    fastForwardMultiplier: 3,   // scroll this many times further while skimming
    // Explicit ranges. Left null, they are derived from the base values above
    // with the ratios below, which reproduce the documented defaults exactly:
    //   clickDelay 1200 -> before 800-1800, after 800-2000
    //   scrollDelay 1500 -> 1200-2500
    minClickDelay: null,
    maxClickDelay: null,
    minPostClickDelay: null,
    maxPostClickDelay: null,
    minScrollDelay: null,
    maxScrollDelay: null,
    verifyTimeout: 3000,            // budget to confirm approved+delete
    maxRetriesPerRecognition: 1,    // exactly one controlled retry, then give up
    scrollIntoViewBeforeClick: true,
    historyFailureLimit: 3,         // give up on an item that failed this often before
    debug: false
  };

  var RATIO = {
    preClickMin: 0.667, preClickMax: 1.5,     // 1200 -> 800 .. 1800
    postClickMin: 0.667, postClickMax: 1.667, // 1200 -> 800 .. 2000
    scrollMin: 0.8, scrollMax: 1.667          // 1500 -> 1200 .. 2500
  };

  var MAX_NOT_VISIBLE_PASSES = 3;   // then retire, so a hidden card can't stall end-of-feed

  /* ===================================================================== */
  /* STATELESS SAFETY HELPERS (exported for tests and for reuse)           */
  /* ===================================================================== */

  /**
   * Deliberately BROAD "already liked" test. EITHER signal alone is enough to
   * refuse a click. We would always rather skip an ambiguous element than
   * delete somebody's approval.
   */
  function looksApproved(el) {
    if (!el) return false;
    return el.classList.contains('approved') || el.getAttribute('data-method') === 'delete';
  }

  /**
   * THE HARD GATE. Returns true only when every condition for a NEW like holds.
   * Called at scan time, again after the pre-click delay, and once more with
   * zero gap before the actual .click().
   */
  function isSafeToLike(el) {
    return safetyCheck(el).ok;
  }

  /** Same gate, but reports which condition failed (for logging). */
  function safetyCheck(el) {
    if (!el) return { ok: false, reason: 'null-element' };
    if (!el.isConnected) return { ok: false, reason: 'detached-from-dom' };
    if (el.tagName !== 'A') return { ok: false, reason: 'not-an-anchor' };
    if (!el.classList.contains('approval_link')) return { ok: false, reason: 'not-an-approval-link' };

    // --- the two conditions that prevent destroying an existing like ---
    if (el.classList.contains('approved')) return { ok: false, reason: 'approved-NEVER-CLICK' };
    if (el.getAttribute('data-method') === 'delete') return { ok: false, reason: 'delete-method-NEVER-CLICK' };

    if (!el.classList.contains('unapproved')) return { ok: false, reason: 'not-unapproved' };
    if (el.getAttribute('data-category') !== 'recognition') return { ok: false, reason: 'not-recognition-category' };
    if (el.getAttribute('data-event') !== 'liked') return { ok: false, reason: 'not-liked-event' };
    if (el.getAttribute('data-method') !== 'post') return { ok: false, reason: 'not-post-method' };

    // Belt and braces: the composed selector must agree with the checks above.
    if (!el.matches(SELECTORS.UNLIKED)) return { ok: false, reason: 'selector-mismatch' };

    var id = recognitionIdOf(el);
    if (!id) return { ok: false, reason: 'no-recognition-id-in-href' };
    if (!SAFE_ID_RE.test(id)) return { ok: false, reason: 'unsafe-recognition-id' };

    return { ok: true, id: id };
  }

  function recognitionIdOf(el) {
    if (!el) return null;
    var href = el.getAttribute('href') || '';
    var m = href.match(RECOGNITION_HREF_RE);
    return m ? m[1] : null;
  }

  function approvalIdOf(el) {
    if (!el) return null;
    var m = (el.getAttribute('href') || '').match(APPROVAL_ID_RE);
    return m ? m[1] : null;
  }

  /* ===================================================================== */
  /* ENGINE                                                                */
  /* ===================================================================== */

  /**
   * @param {Object} opts
   *   root     - element/document to query within (default: doc)
   *   doc      - document (default: global.document)
   *   win      - window used for scrolling/computed styles (default: global)
   *   settings - partial settings object
   *   history  - optional { has(id), get(id), add(id, outcome) } — OPTIMISATION
   *              AND BOOKKEEPING ONLY. It can only ever cause the engine to
   *              skip; it can never authorise a click. The DOM decides.
   *   onUpdate - fn(snapshot) called when state or stats change
   *   onLog    - fn(message, level)
   */
  function createEngine(opts) {
    opts = opts || {};

    var doc = opts.doc || global.document;
    var win = opts.win || global;
    var root = opts.root || doc;
    var history = opts.history || null;
    var onUpdate = opts.onUpdate || function () {};
    var onLog = opts.onLog || null;

    var settings = merge(DEFAULT_SETTINGS, opts.settings || {});

    var state = STATE.STOPPED;
    var stopRequested = false;
    var runPromise = null;
    var lastResult = null;

    // Duplicate protection for this page session. Never a reason to click.
    var processed = new Set();
    var seen = new Set();
    var attempts = Object.create(null);
    var notVisiblePasses = Object.create(null);
    var failedIds = new Set();

    var stats = blankStats();
    var consecutiveAlready = 0;   // already-liked met back to back, in feed order
    var emptyScans = 0;           // consecutive scans with nothing to like
    var scrollContainer = null;
    var observer = null;
    var mutationWaiters = [];
    var timers = new Set();
    var logLines = [];

    function blankStats() {
      return {
        scanned: 0,        // distinct recognitions detected
        newLikes: 0,       // verified approved+delete transitions we caused
        alreadyLiked: 0,   // liked by this user before we arrived
        skipped: 0,
        errors: 0,         // verification failures + exceptions
        scrolls: 0,
        currentRecognitionId: null,
        startedAt: null,
        finishedAt: null
      };
    }

    /* ---------------------------------------------------------------- log */
    function log(msg, level) {
      var line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
      logLines.push(line);
      if (logLines.length > 300) logLines.shift();
      if (settings.debug || level === 'warn' || level === 'error') {
        try {
          var fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
          (global.console || {})[fn]('[RecognizeAutoLiker] ' + msg);
        } catch (e) { /* console unavailable */ }
      }
      if (onLog) { try { onLog(line, level || 'info'); } catch (e) {} }
    }

    function emit() {
      try { onUpdate(snapshot()); } catch (e) { /* host went away */ }
    }

    function snapshot() {
      return {
        version: VERSION,
        state: state,
        stats: merge(stats, {}),
        settings: merge(settings, {}),
        lastResult: lastResult,
        log: logLines.slice(-40)
      };
    }

    /* ------------------------------------------------------------- timing */
    function delayRange(minKey, maxKey, baseKey, ratioMin, ratioMax) {
      var lo = settings[minKey];
      var hi = settings[maxKey];
      var base = Number(settings[baseKey]) || DEFAULT_SETTINGS[baseKey];
      if (!isFiniteNumber(lo)) lo = Math.round(base * ratioMin);
      if (!isFiniteNumber(hi)) hi = Math.round(base * ratioMax);
      if (hi < lo) hi = lo;
      return [lo, hi];
    }

    function preClickDelay() {
      var r = delayRange('minClickDelay', 'maxClickDelay', 'clickDelay', RATIO.preClickMin, RATIO.preClickMax);
      return randInt(r[0], r[1]);
    }
    function postClickDelay() {
      var r = delayRange('minPostClickDelay', 'maxPostClickDelay', 'clickDelay', RATIO.postClickMin, RATIO.postClickMax);
      return randInt(r[0], r[1]);
    }
    function scrollWaitDelay() {
      var r = delayRange('minScrollDelay', 'maxScrollDelay', 'scrollDelay', RATIO.scrollMin, RATIO.scrollMax);
      return randInt(r[0], r[1]);
    }

    /**
     * ONE timer per wait — never a chain of short timers. Chained short
     * timeouts are throttled hard in background tabs (roughly one wake per
     * minute), which would turn a 1.5s wait into 15 minutes. A single timer
     * of the full duration is throttle-friendly, and stop() cancels every
     * pending timer immediately so STOP is still instant.
     */
    function sleep(ms) {
      var wait = Math.max(0, ms | 0);
      return new Promise(function (resolve) {
        var entry = { resolve: resolve, deadline: Date.now() + wait };
        entry.id = setTimeout(function () {
          timers.delete(entry);
          resolve('elapsed');
        }, wait);
        timers.add(entry);
      });
    }

    /**
     * Fire any wait whose deadline has already passed, and report whether the
     * run looks throttled.
     *
     * Chrome clamps timers in a background tab, so a setTimeout can fire long
     * after it was due and the run crawls. The MV3 service worker is not
     * throttled the same way, so it pings us on an alarm and we settle the
     * waits Chrome already owed us. This can never SHORTEN a wait - a timer is
     * only resolved once its own deadline is in the past - so click pacing is
     * completely unchanged.
     */
    function nudge() {
      var now = Date.now();
      var caughtUp = 0;
      var overdueBy = 0;
      timers.forEach(function (entry) {
        if (entry.deadline != null && entry.deadline <= now) {
          overdueBy = Math.max(overdueBy, now - entry.deadline);
          clearTimeout(entry.id);
          timers.delete(entry);
          caughtUp++;
          try { entry.resolve('nudged'); } catch (e) {}
        }
      });
      if (caughtUp) {
        log('Caught up ' + caughtUp + ' wait(s) that were overdue by ' + overdueBy + 'ms (background throttling)');
      }
      return { caughtUp: caughtUp, overdueBy: overdueBy, pending: timers.size };
    }

    function cancelTimers() {
      timers.forEach(function (entry) {
        clearTimeout(entry.id);
        try { entry.resolve('cancelled'); } catch (e) {}
      });
      timers.clear();
    }

    /* ---------------------------------------------------------------- dom */
    function queryAll(selector) {
      try { return Array.prototype.slice.call(root.querySelectorAll(selector)); }
      catch (e) { return []; }
    }

    /**
     * Always re-find by id. A cached element reference is never trusted.
     *
     * The direct attribute selector matters once a long feed is loaded: with a
     * few thousand cards on the page, sweeping every approval link on every
     * lookup is the difference between instant and visibly sluggish. The id is
     * validated against SAFE_ID_RE first, so it is safe to interpolate.
     */
    function findApprovalById(id) {
      if (!id || !SAFE_ID_RE.test(id)) return null;
      try {
        var hit = root.querySelector(
          'a.approval_link[data-category="recognition"][data-event="liked"]' +
          '[href*="/recognitions/' + id + '/approvals"]');
        if (hit) return hit;
      } catch (e) { /* fall through to the sweep */ }
      var all = queryAll(SELECTORS.ANY);
      for (var i = 0; i < all.length; i++) {
        if (recognitionIdOf(all[i]) === id) return all[i];
      }
      return null;
    }

    /** Nearest meaningful recognition card, by DOM relationship not one class. */
    function cardOf(el) {
      if (!el) return null;
      return el.closest(
        '[data-recognition-id], .recognition, .recognition-card, article, li, .card, .feed-item'
      ) || el.parentElement;
    }

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return false;
      var cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return false; }
      if (!cs) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      if (cs.pointerEvents === 'none') return false;
      return true;
    }

    function isEnabled(el) {
      if (!el) return false;
      if (el.hasAttribute('disabled')) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      if (el.classList.contains('disabled')) return false;
      return true;
    }

    /** Full gate + visibility/enabled/context, used before every click. */
    function gate(el) {
      var base = safetyCheck(el);
      if (!base.ok) return base;
      if (!cardOf(el)) return { ok: false, reason: 'no-recognition-container' };
      if (!isVisible(el)) return { ok: false, reason: 'not-visible' };
      if (!isEnabled(el)) return { ok: false, reason: 'disabled' };
      return base;
    }

    /* ---------------------------------------------------- scroll container */
    function isScrollable(el) {
      if (!el || el === doc.documentElement || el === doc.body) return false;
      var cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return false; }
      if (!cs) return false;
      var oy = cs.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      return el.scrollHeight > el.clientHeight + 4;
    }

    /**
     * Walk up from a real recognition card and take the nearest genuinely
     * scrollable ancestor. Falls back to the document scroller. A cached
     * `win` result means "nothing scrollable existed yet" and is always
     * re-probed, because the feed may have grown since.
     */
    function detectScrollContainer(force) {
      if (scrollContainer && scrollContainer !== win && !force && scrollContainer.isConnected) {
        return scrollContainer;
      }
      var anchor = root.querySelector(SELECTORS.ANY);
      var node = anchor ? cardOf(anchor) : null;
      while (node && node !== doc.body && node !== doc.documentElement) {
        if (isScrollable(node)) { scrollContainer = node; return scrollContainer; }
        node = node.parentElement;
      }
      scrollContainer = win;
      return scrollContainer;
    }

    function scrollMetrics(c) {
      if (c === win || !c) {
        var se = doc.scrollingElement || doc.documentElement;
        return {
          top: (win.pageYOffset != null ? win.pageYOffset : se.scrollTop) || 0,
          height: se.scrollHeight,
          client: win.innerHeight || se.clientHeight
        };
      }
      return { top: c.scrollTop, height: c.scrollHeight, client: c.clientHeight };
    }

    function scrollByPixels(c, delta) {
      if (c === win || !c) {
        if (typeof win.scrollBy === 'function') win.scrollBy(0, delta);
        else {
          var se = doc.scrollingElement || doc.documentElement;
          se.scrollTop += delta;
        }
      } else {
        c.scrollTop = c.scrollTop + delta;
      }
    }

    function describe(el) {
      if (!el) return 'null';
      if (el === win) return 'window (document scrolling element)';
      var s = '<' + el.tagName.toLowerCase();
      if (el.id) s += ' id="' + el.id + '"';
      if (el.className && typeof el.className === 'string') s += ' class="' + el.className.trim().slice(0, 80) + '"';
      return s + '>';
    }

    /* --------------------------------------------------- mutation observer */
    function startObserver() {
      if (observer || typeof global.MutationObserver === 'undefined') return;
      var target = (root === doc) ? (doc.body || doc.documentElement) : root;
      if (!target) return;
      observer = new global.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          if (records[i].addedNodes && records[i].addedNodes.length) {
            var waiters = mutationWaiters;
            mutationWaiters = [];
            waiters.forEach(function (w) { try { w(); } catch (e) {} });
            return;
          }
        }
      });
      try { observer.observe(target, { childList: true, subtree: true }); }
      catch (e) { observer = null; }
    }

    function stopObserver() {
      if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
      mutationWaiters = [];
    }

    /**
     * Wait up to ms for the feed to insert nodes. Resolves early (plus a short
     * settle) when the observer fires. No polling loop.
     */
    function waitForFeedActivity(ms) {
      return new Promise(function (resolve) {
        var done = false;
        var settleTimer = null;
        var entry = { resolve: function () {}, deadline: Date.now() + Math.max(0, ms | 0) };
        entry.id = setTimeout(function () {
          if (done) return;
          done = true;
          timers.delete(entry);
          resolve(false);
        }, Math.max(0, ms | 0));
        entry.resolve = function () {                 // stop() cancels the wait
          if (done) return;
          done = true;
          if (settleTimer) clearTimeout(settleTimer);
          resolve(false);
        };
        timers.add(entry);

        mutationWaiters.push(function () {
          if (done) return;
          done = true;
          clearTimeout(entry.id);
          timers.delete(entry);
          settleTimer = setTimeout(function () { resolve(true); }, 350);
        });
      });
    }

    /* ============================ SCAN ================================== */
    function scanFeed() {
      var unliked = [];
      var links = queryAll(SELECTORS.ANY);

      // querySelectorAll returns document order, so the run of already-liked
      // recognitions we count here is genuinely consecutive in the feed.
      links.forEach(function (a) {
        var id = recognitionIdOf(a);
        if (!id) return;
        var isNew = !seen.has(id);
        if (isNew) { seen.add(id); stats.scanned++; }
        if (processed.has(id)) return;

        // Broad check first: anything that looks approved is off-limits.
        if (looksApproved(a)) {
          processed.add(id);
          stats.alreadyLiked++;
          if (isNew) consecutiveAlready++;
          if (history) history.add(id, 'already');
          log('Skipping already liked recognition ' + id);
          return;
        }
        if (a.matches(SELECTORS.UNLIKED)) {
          consecutiveAlready = 0;     // something new: we are not caught up
          unliked.push(id);
        }
      });

      if (links.length) log('Found ' + links.length + ' recognition approval control(s), ' + unliked.length + ' unliked');
      return unliked;
    }

    /* ============================ CLICK ================================= */

    /**
     * The single place in this file that dispatches a click. The gate runs
     * here with ZERO gap before el.click(), so no await, timer, retry or later
     * refactor can insert work between the check and the click. Throws rather
     * than clicking anything it cannot fully verify.
     */
    function performClick(el) {
      var g = gate(el);
      if (!g.ok) throw new Error('refused to click: ' + g.reason);
      // Let the site do its own thing: this is the page's own anchor, wired by
      // Rails UJS (data-remote="true" + data-method="post"). No API is called
      // directly, no token is read, nothing is forged.
      el.click();
    }

    function noteSkip(id, reason) {
      stats.skipped++;
      if (reason.indexOf('not-visible') === 0) {
        notVisiblePasses[id] = (notVisiblePasses[id] || 0) + 1;
        if (notVisiblePasses[id] >= MAX_NOT_VISIBLE_PASSES) {
          processed.add(id);
          log('Retiring ' + id + ' — not visible after ' + notVisiblePasses[id] + ' passes', 'warn');
        } else {
          log('Skipping ' + id + ' (' + reason + ', pass ' + notVisiblePasses[id] + ')');
        }
        return;
      }
      processed.add(id);
      log('Skipping ' + id + ' (' + reason + ')', 'warn');
    }

    /**
     * Confirms the exact documented transition for THIS recognition:
     *   .unapproved + data-method="post"  ->  .approved + data-method="delete"
     * true = confirmed, false = still unapproved / half-changed, null = the
     * element vanished so nothing can be proven (never re-click on null).
     */
    function approvedNow(id, clickedEl) {
      var el = findApprovalById(id);
      if (!el) {
        if (clickedEl && clickedEl.isConnected && clickedEl.matches(SELECTORS.LIKED)) return true;
        return null;
      }
      if (el.matches(SELECTORS.LIKED)) return true;
      return false;
    }

    function verify(id, clickedEl) {
      var deadline = Date.now() + settings.verifyTimeout;
      function poll() {
        var r = approvedNow(id, clickedEl);
        if (r === true) return Promise.resolve(true);
        if (Date.now() >= deadline) return Promise.resolve(r);
        return sleep(200).then(function (how) {
          if (how === 'cancelled' || stopRequested) return approvedNow(id, clickedEl);
          return poll();
        });
      }
      return poll();
    }

    function processRecognition(id) {
      stats.currentRecognitionId = id;
      emit();

      // History may only ever cause a SKIP, never a click. An item that has
      // repeatedly failed verification in past runs is not worth clicking again.
      if (history && settings.historyFailureLimit > 0) {
        var rec = history.get ? history.get(id) : null;
        if (rec && rec.outcome === 'failed' && (rec.failures || 0) >= settings.historyFailureLimit) {
          noteSkip(id, 'previously-failed-' + rec.failures + 'x');
          return Promise.resolve('skipped');
        }
      }

      var el = findApprovalById(id);
      if (!el) { noteSkip(id, 'not-in-dom'); return Promise.resolve('skipped'); }

      if (looksApproved(el)) {
        stats.alreadyLiked++;
        processed.add(id);
        if (history) history.add(id, 'already');
        log('Skipping already liked recognition ' + id);
        return Promise.resolve('already');
      }

      var g = gate(el);
      if (!g.ok) { noteSkip(id, g.reason); return Promise.resolve('skipped'); }

      attempts[id] = (attempts[id] || 0) + 1;
      var attemptNo = attempts[id];
      log('Safe unliked recognition found: ' + id + (attemptNo > 1 ? ' (retry)' : ''));

      if (settings.scrollIntoViewBeforeClick) {
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      }

      return sleep(preClickDelay()).then(function () {
        if (stopRequested) return 'stopped';

        // Re-find and re-gate: the feed may have changed during the delay.
        var fresh = findApprovalById(id);
        if (!fresh) { noteSkip(id, 'disappeared-before-click'); return 'skipped'; }
        if (looksApproved(fresh)) {
          stats.alreadyLiked++;
          processed.add(id);
          if (history) history.add(id, 'already');
          log('Skipping ' + id + ' — became liked while we waited');
          return 'already';
        }
        var g2 = gate(fresh);
        if (!g2.ok) { noteSkip(id, g2.reason + ' (re-check)'); return 'skipped'; }

        try {
          log('Clicking recognition ' + id);
          performClick(fresh);
        } catch (e) {
          stats.errors++;
          failedIds.add(id);
          processed.add(id);
          if (history) history.add(id, 'failed');
          log('Click refused/failed for ' + id + ': ' + (e && e.message), 'error');
          return 'error';
        }

        return sleep(postClickDelay())
          .then(function () { return verify(id, fresh); })
          .then(function (ok) {
            if (ok === true) {
              stats.newLikes++;
              processed.add(id);
              if (history) history.add(id, 'liked');
              var approvalId = approvalIdOf(findApprovalById(id));
              log('Verified liked: ' + id + (approvalId ? ' (approval ' + approvalId + ')' : ''));
              return 'liked';
            }
            if (ok === null) {
              noteSkip(id, 'vanished-during-verification');
              return 'skipped';
            }
            if (attemptNo <= settings.maxRetriesPerRecognition) {
              log('Still unapproved after click: ' + id + ' — one controlled retry', 'warn');
              return processRecognition(id);
            }
            stats.errors++;
            failedIds.add(id);
            processed.add(id);
            if (history) history.add(id, 'failed');
            log('Verification failed for ' + id + ' after ' + attemptNo + ' attempt(s)', 'warn');
            return 'error';
          });
      }).catch(function (e) {
        stats.errors++;
        processed.add(id);
        log('Unhandled error on ' + id + ': ' + (e && e.message), 'error');
        return 'error';
      });
    }

    /* ============================ LOOP ================================== */
    function waitWhilePaused() {
      if (state !== STATE.PAUSED) return Promise.resolve();
      return sleep(250).then(waitWhilePaused);
    }

    function reachedMax() {
      return settings.maxLikesPerRun > 0 && stats.newLikes >= settings.maxLikesPerRun;
    }

    function runLoop() {
      var noNewContent = 0;
      var lastCardCount = countRecognitions();
      var lastScrollHeight = scrollMetrics(detectScrollContainer()).height;

      function countRecognitions() {
        var ids = new Set();
        queryAll(SELECTORS.ANY).forEach(function (a) {
          var id = recognitionIdOf(a);
          if (id) ids.add(id);
        });
        return ids.size;
      }

      function iteration() {
        if (stopRequested) return Promise.resolve(STOP_REASON.USER);
        if (reachedMax()) return Promise.resolve(STOP_REASON.MAX_LIKES);

        return waitWhilePaused().then(function () {
          if (stopRequested) return STOP_REASON.USER;

          var batch = scanFeed();
          emptyScans = batch.length ? 0 : emptyScans + 1;

          function nextItem(i) {
            if (i >= batch.length) return Promise.resolve(null);
            if (stopRequested) return Promise.resolve(STOP_REASON.USER);
            if (reachedMax()) return Promise.resolve(STOP_REASON.MAX_LIKES);
            return waitWhilePaused().then(function () {
              if (stopRequested) return STOP_REASON.USER;
              if (reachedMax()) return STOP_REASON.MAX_LIKES;
              if (processed.has(batch[i])) return nextItem(i + 1);
              return processRecognition(batch[i]).then(function () {
                emit();
                return nextItem(i + 1);
              });
            });
          }

          return nextItem(0).then(function (early) {
            if (early) return early;
            if (stopRequested) return STOP_REASON.USER;
            if (reachedMax()) return STOP_REASON.MAX_LIKES;

            // Caught up: a long unbroken run of posts we had already liked means
            // everything below is older and handled. Checked AFTER this batch,
            // so anything new at the top is always liked first.
            if (settings.stopAfterConsecutiveAlreadyLiked > 0 &&
                consecutiveAlready >= settings.stopAfterConsecutiveAlreadyLiked) {
              log('Caught up: ' + consecutiveAlready + ' already-liked recognitions in a row');
              return STOP_REASON.CAUGHT_UP;
            }

            // ---------------- scroll for more ----------------
            var container = detectScrollContainer();
            var before = scrollMetrics(container);
            var delta = settings.scrollAmount > 0
              ? settings.scrollAmount
              : Math.max(120, Math.round(before.client * (0.60 + Math.random() * 0.15)));

            // Nothing to like around here: skim instead of crawling. Only the
            // scroll changes - no click is ever made faster by this.
            var skimming = settings.fastForward && emptyScans >= settings.fastForwardAfter;
            var wait = scrollWaitDelay();
            if (skimming) {
              var mult = Math.max(1, settings.fastForwardMultiplier);
              delta = Math.round(delta * mult);
              // Never longer than the normal wait: the floor is a sanity guard,
              // not a reason for "fast" to end up slower than "slow".
              wait = Math.min(wait, Math.max(300, Math.round(wait / mult)));
            }

            log((skimming ? 'Fast-forward: scrolling' : 'Scrolling') + ' feed by ' + delta + 'px' +
                (skimming ? ' (nothing to like here)' : '') + ' (' + describe(container) + ')');
            scrollByPixels(container, delta);
            stats.scrolls++;
            stats.currentRecognitionId = null;
            setState(STATE.WAITING);

            return waitForFeedActivity(wait).then(function () {
              if (stopRequested) return STOP_REASON.USER;
              setState(STATE.RUNNING);

              var after = scrollMetrics(container);
              var cards = countRecognitions();
              var pending = scanFeed().length;

              var grewCards = cards > lastCardCount;
              var grewHeight = after.height > lastScrollHeight + 4;
              var moved = Math.abs(after.top - before.top) > 2;
              var atBottom = after.top + after.client >= after.height - 8;

              if (grewCards || grewHeight || pending > 0 || (moved && !atBottom)) {
                noNewContent = 0;
              } else {
                noNewContent++;
                log('No new content (' + noNewContent + '/' + settings.maxNoNewContentAttempts + ')');
              }

              lastCardCount = Math.max(lastCardCount, cards);
              lastScrollHeight = Math.max(lastScrollHeight, after.height);

              if (noNewContent >= settings.maxNoNewContentAttempts) return STOP_REASON.END_OF_FEED;

              emit();
              return iteration();
            });
          });
        });
      }

      return iteration();
    }

    /* ========================== DIAGNOSTICS ============================= */
    function diagnose() {
      var unliked = queryAll(SELECTORS.UNLIKED);
      var liked = queryAll(SELECTORS.LIKED);
      var container = detectScrollContainer(true);
      var m = scrollMetrics(container);

      var report = {
        version: VERSION,
        unlikedCount: unliked.length,
        likedCount: liked.length,
        unlikedIds: unliked.map(recognitionIdOf).filter(Boolean),
        likedIds: liked.map(recognitionIdOf).filter(Boolean),
        sampleHrefs: unliked.slice(0, 5).map(function (a) { return a.getAttribute('href'); }),
        scrollContainer: describe(container),
        scrollHeight: m.height,
        viewportHeight: m.client,
        scrollTop: m.top,
        cardOutline: unliked.length ? outline(unliked[0]) : [],
        selectors: SELECTORS
      };

      log('Diagnostic: ' + report.unlikedCount + ' unliked, ' + report.likedCount +
          ' already liked, container ' + report.scrollContainer);
      return report;
    }

    function outline(el) {
      var chain = [];
      var node = el;
      var depth = 0;
      while (node && depth < 8 && node !== doc.body) {
        chain.unshift(describe(node));
        node = node.parentElement;
        depth++;
      }
      return chain;
    }

    /* =========================== CONTROLS =============================== */
    function setState(next) {
      if (state === next) return;
      state = next;
      emit();
    }

    function reset() {
      processed = new Set();
      seen = new Set();
      failedIds = new Set();
      attempts = Object.create(null);
      notVisiblePasses = Object.create(null);
      stats = blankStats();
      consecutiveAlready = 0;
      emptyScans = 0;
      logLines = [];
    }

    function start(overrides) {
      if (state === STATE.RUNNING || state === STATE.WAITING) return runPromise;
      if (state === STATE.PAUSED) { resume(); return runPromise; }

      if (overrides) updateSettings(overrides);
      reset();
      stopRequested = false;
      stats.startedAt = Date.now();
      setState(STATE.RUNNING);
      startObserver();
      detectScrollContainer(true);
      log('START — max ' + settings.maxLikesPerRun + ' new likes, scroll ' +
          settings.scrollAmount + 'px, container ' + describe(scrollContainer));

      runPromise = runLoop()
        .catch(function (e) {
          log('Fatal loop error: ' + (e && e.message), 'error');
          stats.errors++;
          setState(STATE.ERROR);
          return STOP_REASON.ERROR;
        })
        .then(function (reason) {
          stopRequested = false;
          stats.finishedAt = Date.now();
          stats.currentRecognitionId = null;
          cancelTimers();
          stopObserver();
          if (state !== STATE.ERROR) setState(STATE.STOPPED);
          lastResult = { reason: reason || STOP_REASON.USER, stats: merge(stats, {}) };
          log('FINISHED (' + lastResult.reason + ') — new likes ' + stats.newLikes +
              ', already liked ' + stats.alreadyLiked + ', skipped ' + stats.skipped +
              ', errors ' + stats.errors);
          emit();
          return lastResult;
        });

      return runPromise;
    }

    function pause() {
      if (state !== STATE.RUNNING && state !== STATE.WAITING) return false;
      setState(STATE.PAUSED);
      log('PAUSED — no new clicks; the in-flight operation finishes');
      return true;
    }

    function resume() {
      if (state !== STATE.PAUSED) return false;
      setState(STATE.RUNNING);
      log('RESUMED');
      return true;  // deliberately not the run promise
    }

    function stop(reason) {
      if (state === STATE.STOPPED) return false;
      stopRequested = true;      // checked before EVERY click
      cancelTimers();            // every pending wait resolves at once
      log('STOP' + (reason ? ' (' + reason + ')' : '') + ' — no further clicks');
      return true;
    }

    function updateSettings(patch) {
      if (!patch) return merge(settings, {});
      Object.keys(patch).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) settings[k] = patch[k];
      });
      emit();
      return merge(settings, {});
    }

    return {
      VERSION: VERSION,
      STATE: STATE,
      STOP_REASON: STOP_REASON,
      SELECTORS: SELECTORS,
      start: start,
      pause: pause,
      resume: resume,
      stop: stop,
      diagnose: diagnose,
      snapshot: snapshot,
      getState: function () { return state; },
      getStats: function () { return merge(stats, {}); },
      getSettings: function () { return merge(settings, {}); },
      updateSettings: updateSettings,
      waitForIdle: function () { return runPromise || Promise.resolve(lastResult); },
      processedIds: function () { return Array.from(processed); },
      failedIds: function () { return Array.from(failedIds); },
      detectScrollContainer: detectScrollContainer,
      isSafeToLike: isSafeToLike,
      nudge: nudge,
      pendingWaits: function () { return timers.size; },
      consecutiveAlreadyLiked: function () { return consecutiveAlready; }
    };
  }

  /* ===================================================================== */
  function merge(base, patch) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(patch || {}).forEach(function (k) { out[k] = patch[k]; });
    return out;
  }
  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }
  function randInt(lo, hi) { return Math.round(lo + Math.random() * (hi - lo)); }

  global.RecognizeAutoLiker = {
    VERSION: VERSION,
    SELECTORS: SELECTORS,
    STATE: STATE,
    STOP_REASON: STOP_REASON,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    createEngine: createEngine,
    isSafeToLike: isSafeToLike,
    safetyCheck: safetyCheck,
    looksApproved: looksApproved,
    recognitionIdOf: recognitionIdOf,
    approvalIdOf: approvalIdOf
  };
})(typeof window !== 'undefined' ? window : this);

/*!
 * Recognize Auto Liker — standalone host (userscript / console / bookmarklet)
 * ---------------------------------------------------------------------------
 * The Chrome extension is the primary delivery form. This host exists for the
 * case where a corporate policy blocks unpacked extensions entirely: it wraps
 * the SAME engine (extension/content/engine.js) in a floating control panel,
 * with no chrome.* APIs and no storage.
 *
 * One engine means one safety gate. Nothing about which elements may be
 * clicked is re-implemented here.
 */
(function () {
  'use strict';

  var RAL = window.RecognizeAutoLiker;
  if (!RAL) { console.error('[RecognizeAutoLiker] engine failed to load'); return; }

  var NS = '__RecognizeAutoLiker__';
  if (window[NS] && window[NS].__mounted) {
    window[NS].showPanel();
    return window[NS];
  }

  var engine = RAL.createEngine({ onUpdate: render });
  var host = null, shadow = null, els = {};

  /* ------------------------------------------------------------- panel UI */
  function build() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '.p{font:12px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;width:232px;background:#1e2330;',
      'color:#e8ecf5;border:1px solid #39415a;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden;}',
      '.h{background:#2a3346;padding:8px 10px;font-weight:700;cursor:move;display:flex;',
      'justify-content:space-between;align-items:center;user-select:none;}',
      '.h small{font-weight:400;opacity:.6;}',
      '.b{padding:10px;}',
      '.st{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:700;}',
      '.dot{width:9px;height:9px;border-radius:50%;background:#8a93a8;}',
      '.dot.RUNNING,.dot.WAITING{background:#3ddc84;} .dot.PAUSED{background:#ffc857;}',
      '.dot.ERROR{background:#ff6b6b;}',
      '.g{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin-bottom:9px;}',
      '.g span:nth-child(even){font-variant-numeric:tabular-nums;font-weight:700;}',
      '.m{opacity:.72;font-weight:400 !important;}',
      'label{display:flex;justify-content:space-between;align-items:center;margin:5px 0;opacity:.9;}',
      'input[type=number]{width:74px;background:#141824;color:#e8ecf5;border:1px solid #39415a;',
      'border-radius:5px;padding:3px 6px;font:inherit;text-align:right;}',
      '.r{display:flex;gap:6px;margin-top:9px;}',
      'button{flex:1;padding:6px 4px;border:0;border-radius:6px;font:inherit;font-weight:700;',
      'cursor:pointer;background:#39415a;color:#e8ecf5;}',
      'button:hover:not(:disabled){filter:brightness(1.18);}',
      'button:disabled{opacity:.4;cursor:not-allowed;}',
      '.s{background:#2f8f5b;} .pa{background:#8a6d1f;} .x{background:#a03a3a;}',
      '.d{background:#2f5f8f;margin-top:6px;width:100%;}',
      '.log{margin-top:9px;max-height:88px;overflow:auto;background:#141824;border-radius:6px;padding:6px;',
      'font:10px/1.4 ui-monospace,Consolas,monospace;opacity:.85;white-space:pre-wrap;word-break:break-word;}',
      '.hint{margin-top:6px;font-size:10px;opacity:.55;text-align:center;}'
    ].join('');

    var wrap = document.createElement('div');
    wrap.className = 'p';
    wrap.innerHTML = [
      '<div class="h">Recognize Auto Liker <small>v' + RAL.VERSION + '</small></div>',
      '<div class="b">',
      '  <div class="st"><span class="dot" id="dot"></span><span id="state">STOPPED</span></div>',
      '  <div class="g">',
      '    <span class="m">Scanned</span><span id="c-scanned">0</span>',
      '    <span class="m">Already liked</span><span id="c-already">0</span>',
      '    <span class="m">New likes</span><span id="c-liked">0</span>',
      '    <span class="m">Skipped</span><span id="c-skipped">0</span>',
      '    <span class="m">Errors</span><span id="c-errors">0</span>',
      '  </div>',
      '  <label>Max new likes <input type="number" id="in-max" min="1" step="1"></label>',
      '  <label>Click delay (ms) <input type="number" id="in-click" min="200" step="100"></label>',
      '  <label>Scroll amount (px) <input type="number" id="in-scroll" min="0" step="50"></label>',
      '  <div class="r">',
      '    <button class="s" id="b-start">START</button>',
      '    <button class="pa" id="b-pause">PAUSE</button>',
      '    <button class="x" id="b-stop">STOP</button>',
      '  </div>',
      '  <button class="d" id="b-diag">RUN DIAGNOSTIC (no clicks)</button>',
      '  <div class="log" id="log"></div>',
      '  <div class="hint">Esc = emergency stop</div>',
      '</div>'
    ].join('');

    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    var q = function (id) { return shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector('#' + id); };
    els = {
      dot: q('dot'), state: q('state'),
      scanned: q('c-scanned'), already: q('c-already'), liked: q('c-liked'),
      skipped: q('c-skipped'), errors: q('c-errors'),
      max: q('in-max'), click: q('in-click'), scroll: q('in-scroll'),
      start: q('b-start'), pause: q('b-pause'), stop: q('b-stop'),
      diag: q('b-diag'), log: q('log'), header: wrap.querySelector('.h')
    };

    var s = engine.getSettings();
    els.max.value = s.maxLikesPerRun;
    els.click.value = s.clickDelay;
    els.scroll.value = s.scrollAmount;

    els.start.addEventListener('click', function () { engine.start(readInputs()); });
    els.pause.addEventListener('click', function () {
      if (engine.getState() === 'PAUSED') engine.resume(); else engine.pause();
    });
    els.stop.addEventListener('click', function () { engine.stop('panel STOP'); });
    els.diag.addEventListener('click', function () {
      var r = engine.diagnose();
      console.group('[RecognizeAutoLiker] DIAGNOSTIC (no clicks performed)');
      console.log('Unliked recognitions (clickable):       ' + r.unlikedCount);
      console.log('Liked by you (approved+delete, SKIPPED): ' + r.likedCount);
      console.log('NOTE: the +N text is the total from all users and is never used.');
      console.log('Feed scroll container: ' + r.scrollContainer);
      console.log('Scroll height ' + r.scrollHeight + ', viewport ' + r.viewportHeight);
      r.unlikedIds.slice(0, 10).forEach(function (id, i) {
        console.log('Recognition ID: ' + id + '   Approval href: ' + (r.sampleHrefs[i] || ''));
      });
      console.groupEnd();
    });
    [els.max, els.click, els.scroll].forEach(function (i) {
      i.addEventListener('change', function () { engine.updateSettings(readInputs()); });
    });

    makeDraggable(els.header, host);
    render(engine.snapshot());
  }

  function readInputs() {
    var out = {};
    var max = parseInt(els.max.value, 10);
    var click = parseInt(els.click.value, 10);
    var scroll = parseInt(els.scroll.value, 10);
    if (isFinite(max) && max > 0) out.maxLikesPerRun = max;
    if (isFinite(click) && click >= 200) out.clickDelay = click;
    if (isFinite(scroll) && scroll >= 0) out.scrollAmount = scroll;
    return out;
  }

  function makeDraggable(handle, target) {
    var dragging = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      var r = target.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      target.style.right = 'auto'; target.style.bottom = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      target.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox)) + 'px';
      target.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy)) + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
  }

  function render(snap) {
    if (!els.state) return;
    var st = snap.state, s = snap.stats;
    els.dot.className = 'dot ' + st;
    els.state.textContent = st;
    els.scanned.textContent = s.scanned;
    els.already.textContent = s.alreadyLiked;
    els.liked.textContent = s.newLikes;
    els.skipped.textContent = s.skipped;
    els.errors.textContent = s.errors;
    els.start.disabled = st !== 'STOPPED';
    els.pause.textContent = st === 'PAUSED' ? 'RESUME' : 'PAUSE';
    els.pause.disabled = st === 'STOPPED' || st === 'ERROR';
    els.stop.disabled = st === 'STOPPED';
    els.log.textContent = (snap.log || []).join('\n');
    els.log.scrollTop = els.log.scrollHeight;
  }

  // Emergency stop, capture phase so the page cannot swallow it first.
  window.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.keyCode === 27) && engine.getState() !== 'STOPPED') {
      engine.stop('Esc emergency stop');
    }
  }, true);

  var api = {
    __mounted: true,
    engine: engine,
    version: RAL.VERSION,
    SELECTORS: RAL.SELECTORS,
    start: function (o) { return engine.start(o); },
    pause: function () { return engine.pause(); },
    resume: function () { return engine.resume(); },
    stop: function (r) { return engine.stop(r); },
    diagnose: function () { return engine.diagnose(); },
    stats: function () { return engine.getStats(); },
    setConfig: function (c) { return engine.updateSettings(c); },
    getConfig: function () { return engine.getSettings(); },
    waitForIdle: function () { return engine.waitForIdle(); },
    showPanel: function () { build(); host.style.display = ''; },
    hidePanel: function () { if (host) host.style.display = 'none'; }
  };
  Object.defineProperty(api, 'state', { get: function () { return engine.getState(); } });
  window[NS] = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();

  return api;
})();
