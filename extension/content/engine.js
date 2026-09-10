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
      return new Promise(function (resolve) {
        var entry = { resolve: resolve };
        entry.id = setTimeout(function () {
          timers.delete(entry);
          resolve('elapsed');
        }, Math.max(0, ms | 0));
        timers.add(entry);
      });
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

    /** Always re-find by id. A cached element reference is never trusted. */
    function findApprovalById(id) {
      if (!id || !SAFE_ID_RE.test(id)) return null;
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
        var entry = { resolve: function () {} };
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

      links.forEach(function (a) {
        var id = recognitionIdOf(a);
        if (!id) return;
        if (!seen.has(id)) { seen.add(id); stats.scanned++; }
        if (processed.has(id)) return;

        // Broad check first: anything that looks approved is off-limits.
        if (looksApproved(a)) {
          processed.add(id);
          stats.alreadyLiked++;
          if (history) history.add(id, 'already');
          log('Skipping already liked recognition ' + id);
          return;
        }
        if (a.matches(SELECTORS.UNLIKED)) unliked.push(id);
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

            // ---------------- scroll for more ----------------
            var container = detectScrollContainer();
            var before = scrollMetrics(container);
            var delta = settings.scrollAmount > 0
              ? settings.scrollAmount
              : Math.max(120, Math.round(before.client * (0.60 + Math.random() * 0.15)));

            log('Scrolling feed by ' + delta + 'px (' + describe(container) + ')');
            scrollByPixels(container, delta);
            stats.scrolls++;
            stats.currentRecognitionId = null;
            setState(STATE.WAITING);

            return waitForFeedActivity(scrollWaitDelay()).then(function () {
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
      isSafeToLike: isSafeToLike
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
