/*!
 * Recognize Auto Liker for iPhone / iOS Safari — v2.0.0
 * GENERATED FILE — do not edit.
 * Sources: extension/content/engine.js + iphone-safari/src/ios-panel.js
 * Rebuild: node tools/build-ios.cjs
 *
 * Paste this whole file into the Shortcuts action
 * "Run JavaScript on Web Page" (Safari > Share > your Shortcut).
 *
 * It only clicks recognitions you have NOT liked. It never removes a like you
 * already gave. It sends nothing anywhere and reads no credentials, cookies or
 * tokens — everything happens inside the Safari page you already logged into.
 */
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
    PAGE_DONE: 'PAGE_DONE',
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
    fastForwardMaxMultiplier: 12, // ...escalating up to this over a long dead stretch
    /*
     * When the feed exposes real ?page=N pagination there is no reason to
     * infinite-scroll at all: load a page, clear it, move to the next. With
     * this false the run finishes the recognitions on the current page and
     * ends with PAGE_DONE instead of scrolling for more.
     */
    scrollForMore: true,
    /*
     * Page mode only. The grid keeps its infinite scroll alive even when a
     * ?page=N URL is opened, so anything that scrolls - including bringing a
     * card into view before clicking it - wakes the loader and drags the next
     * pages in. The run then never finishes "this page", never navigates, and
     * quietly turns back into the infinite scroll we were trying to escape.
     * With this on, only recognitions present when the page was opened are
     * ever processed; anything appended later belongs to a page we will
     * navigate to properly.
     */
    limitToInitialSet: false,
    /*
     * THE ANSWER TO "THE PAGE HANGS WHILE IT LOADS".
     * An infinite feed never throws anything away, so after a couple of thousand
     * cards the tab is holding thousands of avatars and DOM nodes and Chrome
     * grinds to a halt. Once the page is carrying more than pruneWhenCardsExceed
     * recognitions, cards we have already finished with and that are scrolled
     * well above the viewport are removed, keeping the most recent
     * keepRecentCards intact. Only already-processed, off-screen cards are ever
     * touched, and the scroll position is corrected so the view does not jump.
     */
    pruneProcessedCards: true,
    pruneWhenCardsExceed: 400,
    keepRecentCards: 120,
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
    var initialIds = null;        // page mode: the recognitions this page came with
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
        pruned: 0,
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

    /* ============================ PRUNE ================================= */
    /**
     * Drop cards we are completely done with, to keep the tab responsive on a
     * feed with thousands of posts.
     *
     * Rules, in order of importance:
     *   - only cards whose recognition id is in `processed` (finished with);
     *   - only cards entirely ABOVE the viewport, never anything on screen or
     *     below it;
     *   - never the most recent `keepRecentCards`, so the feed's own lazy
     *     loader always has plenty of context left;
     *   - all measurements are taken BEFORE any removal, so we never thrash
     *     layout by interleaving reads and writes.
     *
     * The visible scroll position is preserved by anchoring on the first card
     * that survives: whatever it moved by, we move the scroll by the same
     * amount. That is correct whether or not Chrome's own scroll anchoring
     * also fires.
     */
    function pruneOldCards(container) {
      if (!settings.pruneProcessedCards) return 0;

      var links = queryAll(SELECTORS.ANY);
      if (links.length <= settings.pruneWhenCardsExceed) return 0;

      var limit = links.length - settings.keepRecentCards;
      if (limit <= 0) return 0;

      // "Above the viewport" means above the TOP OF THE FEED CONTAINER, not the
      // top of the window. The feed is usually an inner scrolling div that
      // starts partway down the page (or below the fold entirely), so
      // comparing against 0 would either prune nothing at all or stop far too
      // early.
      var boundaryTop = 0;
      if (container && container !== win) {
        try { boundaryTop = container.getBoundingClientRect().top; } catch (e) { boundaryTop = 0; }
      }

      // --- read phase: decide everything before touching the DOM ---
      var doomed = [];
      for (var i = 0; i < limit; i++) {
        var link = links[i];
        var id = recognitionIdOf(link);
        if (!id || !processed.has(id)) continue;       // not finished with it
        var card = cardOf(link);
        if (!card || card === root || card === container) continue;
        var rect;
        try { rect = card.getBoundingClientRect(); } catch (e) { continue; }
        if (rect.bottom >= boundaryTop) break;         // reached the visible feed
        doomed.push(card);
      }
      if (!doomed.length) return 0;

      // Anchor on the first card that survives, so we can restore the view.
      var anchor = null, anchorTop = 0;
      var survivors = queryAll(SELECTORS.ANY);
      for (var j = 0; j < survivors.length; j++) {
        var c = cardOf(survivors[j]);
        if (c && doomed.indexOf(c) === -1) {
          anchor = c;
          try { anchorTop = c.getBoundingClientRect().top; } catch (e) { anchor = null; }
          break;
        }
      }

      // --- write phase ---
      for (var k = 0; k < doomed.length; k++) {
        try { doomed[k].remove(); } catch (e) {}
      }

      if (anchor && anchor.isConnected) {
        try {
          var shift = anchor.getBoundingClientRect().top - anchorTop;
          if (Math.abs(shift) > 1) scrollByPixels(container, shift);
        } catch (e) {}
      }

      stats.pruned += doomed.length;
      log('Pruned ' + doomed.length + ' finished card(s) above the viewport to keep the page responsive');
      return doomed.length;
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
        // Appended by the site's own lazy loader after we arrived: not ours.
        if (initialIds && !initialIds.has(id)) return;
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
      var skimGrace = false;   // a miss while skimming buys one full-speed retry

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

            // -------- page mode: this page is finished, hand back ---------
            if (!settings.scrollForMore) {
              // One settle-and-rescan first: these grids render progressively,
              // so a card can appear a moment after the rest.
              return sleep(Math.min(1200, scrollWaitDelay())).then(function () {
                if (stopRequested) return STOP_REASON.USER;
                if (scanFeed().length) return iteration();   // late arrivals
                log('Page finished: ' + stats.newLikes + ' new like(s), ' +
                    stats.alreadyLiked + ' already liked');
                return STOP_REASON.PAGE_DONE;
              });
            }

            // ---------------- scroll for more ----------------
            var container = detectScrollContainer();

            // Let go of finished cards BEFORE measuring, so the before/after
            // comparison below is taken on the same, already-pruned page.
            pruneOldCards(container);

            var scannedBefore = stats.scanned;
            var before = scrollMetrics(container);
            var delta = settings.scrollAmount > 0
              ? settings.scrollAmount
              : Math.max(120, Math.round(before.client * (0.60 + Math.random() * 0.15)));

            // Nothing to like around here: skim instead of crawling. Only the
            // scroll changes - no click is ever made faster by this.
            // Skim only while we are confident there is more feed below us.
            // After any miss we go back to full speed before drawing
            // conclusions, because a shortened wait is not evidence of anything.
            var skimming = settings.fastForward &&
                           emptyScans >= settings.fastForwardAfter &&
                           noNewContent === 0 &&
                           !skimGrace;
            var wait = scrollWaitDelay();

            if (skimming) {
              // The longer the dead stretch, the bigger the jumps. Walking a
              // couple of thousand already-liked posts at one screen per step
              // is the slow part of a catch-up run.
              var steps = Math.max(1, Math.floor(emptyScans / Math.max(1, settings.fastForwardAfter)));
              var mult = Math.min(
                Math.max(1, settings.fastForwardMaxMultiplier),
                Math.max(1, settings.fastForwardMultiplier) * steps
              );
              delta = Math.round(delta * mult);
              // Never longer than the normal wait: the floor is a sanity guard,
              // not a reason for "fast" to end up slower than "slow".
              wait = Math.min(wait, Math.max(300, Math.round(wait / mult)));
            } else if (noNewContent > 0) {
              // Each consecutive miss waits longer. A feed that is merely slow
              // to hand over the next page should not look like the end of it.
              wait = Math.round(wait * (1 + noNewContent * 0.75));
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
              var pending = scanFeed().length;   // this is what updates stats.scanned

              // Prune-safe signals only. stats.scanned counts distinct
              // recognitions ever seen, so it never goes down; heights are
              // compared within this one iteration rather than against an
              // all-time maximum that pruning would invalidate.
              var foundMore = stats.scanned > scannedBefore;
              var grewHeight = after.height > before.height + 4;
              var moved = Math.abs(after.top - before.top) > 2;
              var atBottom = after.top + after.client >= after.height - 8;

              if (foundMore || grewHeight || pending > 0 || (moved && !atBottom)) {
                noNewContent = 0;
                skimGrace = false;
              } else if (skimming) {
                // We were skimming with a deliberately short wait, so this miss
                // proves nothing: the feed may simply be slower than the wait.
                // Retry the same spot at full speed before counting it.
                skimGrace = true;
                log('Nothing new after a fast scroll - retrying at full speed before calling it the end');
              } else {
                noNewContent++;
                skimGrace = false;
                log('No new content (' + noNewContent + '/' + settings.maxNoNewContentAttempts + ')');
              }

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
        pagination: detectPagination(),
        selectors: SELECTORS
      };

      log('Diagnostic: ' + report.unlikedCount + ' unliked, ' + report.likedCount +
          ' already liked, container ' + report.scrollContainer);

      try {
        console.group('[RecognizeAutoLiker] Feed navigation options');
        if (report.pagination.usable) {
          console.log('This feed appears to expose a way to jump directly. Details:');
        } else {
          console.log('No pagination, "load more" control or cursor attribute found.');
          console.log('That means the feed can only be walked sequentially - there is no');
          console.log('way to resume partway down without loading what comes before it.');
        }
        console.log(report.pagination);
        console.groupEnd();
      } catch (e) {}

      return report;
    }

    /**
     * Looks for a way to jump straight to a point in the feed instead of
     * scrolling there. An infinite feed can only be walked sequentially unless
     * the site exposes pages or a cursor, so this reports whatever it finds and
     * lets a human decide whether it is usable. It never follows anything.
     */
    function detectPagination() {
      var found = { pageLinks: [], nextLinks: [], loadMore: [], cursorAttributes: [], urlParams: [] };

      try {
        queryAll('a[href*="page="], a[href*="per_page="], a[href*="offset="]').slice(0, 8)
          .forEach(function (a) { found.pageLinks.push(a.getAttribute('href')); });

        queryAll('a[rel="next"], link[rel="next"], [data-next-page], [data-next-url]').slice(0, 5)
          .forEach(function (el) {
            found.nextLinks.push(el.getAttribute('href') || el.getAttribute('data-next-url') || describe(el));
          });

        // Text-based "load more" affordances, matched loosely on purpose.
        queryAll('a, button').forEach(function (el) {
          if (found.loadMore.length >= 5) return;
          var text = (el.textContent || '').trim().toLowerCase();
          if (!text || text.length > 40) return;
          if (/load more|show more|see more|older|view more|next page/.test(text)) {
            found.loadMore.push(text + '  ->  ' + describe(el));
          }
        });

        ['data-page', 'data-cursor', 'data-offset', 'data-last-id', 'data-oldest', 'data-before']
          .forEach(function (attr) {
            var el = root.querySelector('[' + attr + ']');
            if (el) found.cursorAttributes.push(attr + '="' + el.getAttribute(attr) + '" on ' + describe(el));
          });

        var qs = (doc.location && doc.location.search) || '';
        if (qs) qs.replace(/^\?/, '').split('&').forEach(function (pair) {
          if (pair) found.urlParams.push(pair);
        });
      } catch (e) { /* diagnostics must never throw */ }

      found.usable = !!(found.pageLinks.length || found.nextLinks.length ||
                        found.loadMore.length || found.cursorAttributes.length);
      return found;
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

      initialIds = null;
      if (settings.limitToInitialSet) {
        initialIds = new Set();
        queryAll(SELECTORS.ANY).forEach(function (a) {
          var id = recognitionIdOf(a);
          if (id) initialIds.add(id);
        });
        log('Page mode: working the ' + initialIds.size + ' recognition(s) this page came with');
      }

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
      consecutiveAlreadyLiked: function () { return consecutiveAlready; },
      pruneNow: function () { return pruneOldCards(detectScrollContainer()); }
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
 * Recognize Auto Liker — iOS Safari host
 * ---------------------------------------------------------------------------
 * Wraps the SAME engine the Chrome extension runs (extension/content/engine.js)
 * in a touch-friendly panel, for Safari's "Run JavaScript on Web Page" action.
 *
 * No chrome.* APIs, no storage, no network, no libraries. Everything runs
 * inside the Safari page you already opened and logged into.
 *
 * The click-safety gate is NOT re-implemented here. Whether an element may be
 * clicked is decided entirely by the shared engine, so iPhone and desktop
 * enforce byte-identical rules:
 *
 *   a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]
 *
 * and never anything carrying `approved` or `data-method="delete"`.
 */
(function () {
  'use strict';

  var NS = '__RecognizeAutoLikerIOS__';

  /* ------------------------------------------------------------------ *
   * Safari's Run-JavaScript action hands the script a `completion()`.   *
   * The Shortcut BLOCKS until it is called, so we call it as soon as    *
   * the panel is up — the automation then keeps running in the page,    *
   * driven by the panel, long after the Shortcut itself has finished.   *
   * ------------------------------------------------------------------ */
  function finishShortcut(summary) {
    try {
      if (typeof completion === 'function') completion(summary);
    } catch (e) { /* not running inside Shortcuts — pasted or bookmarklet */ }
  }

  var RAL = window.RecognizeAutoLiker;
  if (!RAL) {
    finishShortcut('Recognize Auto Liker: engine failed to load.');
    return;
  }

  // Re-running the Shortcut on a page that already has the panel just reveals it.
  if (window[NS] && window[NS].__mounted) {
    window[NS].show();
    finishShortcut('Recognize Auto Liker panel is already open.');
    return window[NS];
  }

  /* -------------------------------------------------------- iOS defaults */
  // Deliberately more conservative than desktop, and matching the documented
  // iPhone timings: before a click 800-1800ms, after a click 1000-2500ms,
  // after a scroll 1200-2500ms.
  var IOS_DEFAULTS = {
    maxLikesPerRun: 50,
    scrollAmount: 0,            // 0 = 60-75% of the feed height, adapts to the device
    scrollDelay: 1500,          // -> 1200-2500ms
    clickDelay: 1200,           // -> 800-1800ms before a click
    minPostClickDelay: 1000,    // explicit: 1000-2500ms after a click
    maxPostClickDelay: 2500,
    maxNoNewContentAttempts: 5,
    verifyTimeout: 3000,
    debug: false
  };

  // The generator can prepend window.__RAL_IOS_CONFIG__ = {...} to preset these.
  var settings = {};
  Object.keys(IOS_DEFAULTS).forEach(function (k) { settings[k] = IOS_DEFAULTS[k]; });
  var preset = window.__RAL_IOS_CONFIG__;
  if (preset && typeof preset === 'object') {
    Object.keys(IOS_DEFAULTS).forEach(function (k) {
      if (preset[k] != null) settings[k] = preset[k];
    });
  }

  var engine = RAL.createEngine({ settings: settings, onUpdate: render });
  var host = null, shadow = null, els = {}, collapsed = false;

  /* ------------------------------------------------------------ panel UI */
  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'ral-ios-host';
    host.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0',
      'z-index:2147483647', 'pointer-events:none'
    ].join(';');
    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
      '.wrap{pointer-events:auto;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      'background:#171c27;color:#e9edf5;border-top:1px solid #333d54;',
      'border-radius:16px 16px 0 0;box-shadow:0 -6px 26px rgba(0,0,0,.45);',
      // Keep clear of the home indicator on notched iPhones.
      'padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));',
      'max-height:70vh;overflow:auto;-webkit-overflow-scrolling:touch;}',
      '.bar{display:flex;align-items:center;gap:8px;}',
      '.dot{width:10px;height:10px;border-radius:50%;background:#8b93a7;flex:none;}',
      '.dot.RUNNING,.dot.WAITING{background:#3ddc84;} .dot.PAUSED{background:#ffc857;}',
      '.dot.ERROR{background:#ff6b6b;}',
      '.title{font-weight:700;font-size:15px;}',
      '.state{margin-left:auto;font-weight:700;font-size:13px;opacity:.85;}',
      '.toggle{margin-left:8px;background:none;border:0;color:#98a2ba;font-size:20px;',
      'line-height:1;padding:4px 8px;min-width:auto;min-height:auto;}',
      '.body{margin-top:10px;}',
      '.body[hidden]{display:none;}',
      '.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;}',
      '.stat{background:#1f2634;border-radius:10px;padding:7px 8px;text-align:center;}',
      '.stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums;}',
      '.stat span{font-size:10px;opacity:.65;text-transform:uppercase;letter-spacing:.04em;}',
      '.stat.hi b{color:#3ddc84;}',
      '.cur{font-size:12px;opacity:.75;margin-bottom:10px;display:flex;justify-content:space-between;gap:8px;}',
      '.cur code{background:#1f2634;padding:2px 7px;border-radius:5px;font-size:12px;}',
      '.row{display:flex;gap:8px;}',
      // 44px minimum: Apple's touch-target guidance.
      'button{flex:1;min-height:44px;border:0;border-radius:11px;font:inherit;font-weight:700;',
      'font-size:15px;color:#e9edf5;background:#39415a;cursor:pointer;}',
      'button:disabled{opacity:.4;}',
      '.start{background:#2f8f5b;} .pause{background:#8a6d1f;} .stop{background:#a03a3a;}',
      '.set{margin-top:10px;border-top:1px solid #2c3446;padding-top:9px;}',
      '.set label{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'margin:8px 0;font-size:13px;opacity:.9;}',
      '.set input{width:92px;min-height:36px;background:#141824;color:#e9edf5;border:1px solid #333d54;',
      'border-radius:8px;padding:4px 9px;font:inherit;font-size:15px;text-align:right;}',
      '.note{margin-top:9px;font-size:11px;opacity:.55;line-height:1.45;}',
      '.log{margin-top:9px;max-height:84px;overflow:auto;background:#141824;border-radius:9px;',
      'padding:7px 9px;font:10px/1.45 ui-monospace,Menlo,monospace;opacity:.8;white-space:pre-wrap;',
      'word-break:break-word;}'
    ].join('');

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = [
      '<div class="bar">',
      '  <span class="dot" id="dot"></span>',
      '  <span class="title">Recognize Auto Liker</span>',
      '  <span class="state" id="state">STOPPED</span>',
      '  <button class="toggle" id="toggle" aria-label="Collapse">&#9662;</button>',
      '</div>',
      '<div class="body" id="body">',
      '  <div class="stats">',
      '    <div class="stat hi"><b id="s-liked">0</b><span>New likes</span></div>',
      '    <div class="stat"><b id="s-already">0</b><span>Already</span></div>',
      '    <div class="stat"><b id="s-scanned">0</b><span>Scanned</span></div>',
      '    <div class="stat"><b id="s-skipped">0</b><span>Skipped</span></div>',
      '    <div class="stat"><b id="s-errors">0</b><span>Errors</span></div>',
      '    <div class="stat"><b id="s-scrolls">0</b><span>Scrolls</span></div>',
      '  </div>',
      '  <div class="cur"><span>Current recognition</span><code id="current">&ndash;</code></div>',
      '  <div class="row">',
      '    <button class="start" id="b-start">START</button>',
      '    <button class="pause" id="b-pause">PAUSE</button>',
      '    <button class="stop"  id="b-stop">STOP</button>',
      '  </div>',
      '  <div class="set">',
      '    <label>Maximum new likes<input type="number" inputmode="numeric" id="in-max" min="1" step="1"></label>',
      '    <label>Scroll amount (0 = auto)<input type="number" inputmode="numeric" id="in-scroll" min="0" step="50"></label>',
      '    <label>Scroll delay (ms)<input type="number" inputmode="numeric" id="in-sdelay" min="200" step="100"></label>',
      '    <label>Click delay (ms)<input type="number" inputmode="numeric" id="in-cdelay" min="200" step="100"></label>',
      '  </div>',
      '  <div class="log" id="log"></div>',
      '  <div class="note">Keep this Safari tab open and on screen. iOS suspends pages in the ',
      '  background, so the run pauses if you switch apps or lock the phone, and continues ',
      '  when you come back. Only recognitions you have not liked are ever clicked.</div>',
      '</div>'
    ].join('');

    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    var q = function (id) { return shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector('#' + id); };
    els = {
      dot: q('dot'), state: q('state'), body: q('body'), toggle: q('toggle'),
      liked: q('s-liked'), already: q('s-already'), scanned: q('s-scanned'),
      skipped: q('s-skipped'), errors: q('s-errors'), scrolls: q('s-scrolls'),
      current: q('current'), log: q('log'),
      start: q('b-start'), pause: q('b-pause'), stop: q('b-stop'),
      max: q('in-max'), scroll: q('in-scroll'), sdelay: q('in-sdelay'), cdelay: q('in-cdelay')
    };

    var s = engine.getSettings();
    els.max.value = s.maxLikesPerRun;
    els.scroll.value = s.scrollAmount;
    els.sdelay.value = s.scrollDelay;
    els.cdelay.value = s.clickDelay;

    els.start.addEventListener('click', function () { engine.start(readInputs()); });
    els.pause.addEventListener('click', function () {
      if (engine.getState() === 'PAUSED') engine.resume(); else engine.pause();
    });
    els.stop.addEventListener('click', function () { engine.stop('panel STOP'); });
    els.toggle.addEventListener('click', function () {
      collapsed = !collapsed;
      els.body.hidden = collapsed;
      els.toggle.innerHTML = collapsed ? '&#9652;' : '&#9662;';
    });
    [els.max, els.scroll, els.sdelay, els.cdelay].forEach(function (input) {
      input.addEventListener('change', function () { engine.updateSettings(readInputs()); });
    });

    // Emergency stop for an attached hardware keyboard. iPhones have no Esc
    // key on the software keyboard, which is why STOP is a large, always
    // visible button and the panel cannot be scrolled away.
    window.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.keyCode === 27) && engine.getState() !== 'STOPPED') {
        engine.stop('Esc emergency stop');
      }
    }, true);

    render(engine.snapshot());
  }

  function readInputs() {
    var out = {};
    var max = parseInt(els.max.value, 10);
    var scroll = parseInt(els.scroll.value, 10);
    var sdelay = parseInt(els.sdelay.value, 10);
    var cdelay = parseInt(els.cdelay.value, 10);
    if (isFinite(max) && max > 0) out.maxLikesPerRun = max;
    if (isFinite(scroll) && scroll >= 0) out.scrollAmount = scroll;
    if (isFinite(sdelay) && sdelay >= 200) out.scrollDelay = sdelay;
    if (isFinite(cdelay) && cdelay >= 200) out.clickDelay = cdelay;
    return out;
  }

  function render(snap) {
    if (!els.state) return;
    var st = snap.state, s = snap.stats;
    els.dot.className = 'dot ' + st;
    els.state.textContent = st;
    els.liked.textContent = s.newLikes;
    els.already.textContent = s.alreadyLiked;
    els.scanned.textContent = s.scanned;
    els.skipped.textContent = s.skipped;
    els.errors.textContent = s.errors;
    els.scrolls.textContent = s.scrolls;
    els.current.textContent = s.currentRecognitionId || '–';

    var running = st === 'RUNNING' || st === 'WAITING';
    els.start.disabled = running || st === 'PAUSED';
    els.pause.textContent = st === 'PAUSED' ? 'RESUME' : 'PAUSE';
    els.pause.disabled = !running && st !== 'PAUSED';
    els.stop.disabled = st === 'STOPPED';

    els.log.textContent = (snap.log || []).slice(-25).join('\n');
    els.log.scrollTop = els.log.scrollHeight;
  }

  /* --------------------------------------------------------------- export */
  var api = {
    __mounted: true,
    version: RAL.VERSION,
    engine: engine,
    SELECTORS: RAL.SELECTORS,
    start: function (o) { return engine.start(o); },
    pause: function () { return engine.pause(); },
    resume: function () { return engine.resume(); },
    stop: function (r) { return engine.stop(r); },
    diagnose: function () { return engine.diagnose(); },
    stats: function () { return engine.getStats(); },
    getSettings: function () { return engine.getSettings(); },
    updateSettings: function (c) { return engine.updateSettings(c); },
    waitForIdle: function () { return engine.waitForIdle(); },
    show: function () { build(); host.style.display = ''; collapsed = false; els.body.hidden = false; },
    hide: function () { if (host) host.style.display = 'none'; }
  };
  Object.defineProperty(api, 'state', { get: function () { return engine.getState(); } });
  window[NS] = api;

  build();

  var found = engine.diagnose();
  finishShortcut(
    'Recognize Auto Liker is ready. ' + found.unlikedCount + ' recognition(s) not yet liked, ' +
    found.likedCount + ' already liked. Tap START in the panel at the bottom of the page.'
  );

  return api;
})();
