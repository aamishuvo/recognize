// ==UserScript==
// @name         Recognize Auto Liker
// @namespace    local.recognize.autoliker
// @version      1.0.0
// @description  Likes RecognizeApp recognition posts you have not liked yet. No login/credential handling.
// @author       local
// @match        https://*.recognizeapp.com/*
// @match        https://recognizeapp.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/* GENERATED FILE — do not edit.
   Source: src/recognize-auto-liker.js   Build: node tools/build.cjs */

/*!
 * Recognize Auto Liker — core engine
 * ---------------------------------------------------------------------------
 * Clicks the Like ("+") approval control on RecognizeApp recognition posts that
 * the currently logged-in user has NOT already liked.
 *
 * Scope / non-goals (deliberate):
 *   - NO login automation, NO credential handling, NO password storage.
 *   - NO cookie extraction, NO auth bypass, NO API token use.
 *   - It only clicks DOM elements in a session a human already opened.
 *
 * The one and only production click target:
 *   a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]
 *
 * Public API (window.__RecognizeAutoLiker__):
 *   start(), pause(), resume(), stop(), diagnose(), stats(),
 *   setConfig(obj), getConfig(), waitForIdle(), showPanel(), hidePanel(),
 *   state, version, SELECTORS
 */
(function () {
  'use strict';

  var NS = '__RecognizeAutoLiker__';
  var VERSION = '1.0.0';

  if (window[NS] && window[NS].__mounted) {
    window[NS].showPanel();
    window[NS].log('Already loaded (v' + window[NS].version + '). Panel restored.');
    return window[NS];
  }

  /* ======================================================================
   * SELECTORS — the DOM state is authoritative, never the visible text.
   * ==================================================================== */
  var SELECTORS = {
    // Primary production selector. Nothing else is ever clicked.
    UNLIKED:
      'a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]',
    // Already-liked state, counted but never clicked.
    LIKED:
      'a.approval_link.approved[data-category="recognition"][data-event="liked"]',
    // Any recognition approval link, either state (diagnostics + verification).
    ANY:
      'a.approval_link[data-category="recognition"][data-event="liked"]'
  };

  // /banglalink.net/recognitions/rglauokd/approvals?approvers_limit=5
  //                              ^^^^^^^^ recognition id
  var RECOGNITION_HREF_RE = /\/recognitions\/([A-Za-z0-9_-]+)\/approvals(?:\/|\?|$)/;
  var SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

  /* ======================================================================
   * CONFIG
   * ==================================================================== */
  var DEFAULT_CONFIG = {
    maxLikes: 500,
    // Base delay in ms. All randomized ranges below are expressed for a base of
    // 1000ms and scale linearly with it (base 2000 => every window doubles).
    baseDelay: 1000,
    preClickDelayRange: [500, 1200],
    postClickDelayRange: [800, 1800],
    postScrollDelayRange: [1500, 2500],
    // Scroll 60–75% of the visible feed height per step.
    scrollFractionRange: [0.60, 0.75],
    maxNoNewContentAttempts: 5,
    // Verification budget after a click before we call it a miss.
    verifyTimeoutMs: 2500,
    verifyPollMs: 150,
    // One retry, then mark failed. Never hammer.
    maxRetriesPerRecognition: 1,
    // Bring the target into view before clicking (more human, avoids lazy DOM).
    scrollIntoViewBeforeClick: true,
    diagnostic: false,
    verbose: true
  };

  var config = shallowClone(DEFAULT_CONFIG);

  /* ======================================================================
   * STATE
   * ==================================================================== */
  var STATE = { STOPPED: 'STOPPED', RUNNING: 'RUNNING', PAUSED: 'PAUSED', STOPPING: 'STOPPING' };

  var state = STATE.STOPPED;
  var stopRequested = false;
  var runPromise = null;

  // Recognition ids we have finished with (liked / already-liked / failed /
  // permanently skipped). Survives scrolling & DOM re-renders — this is what
  // prevents a second click on the same recognition.
  var processed = new Set();
  var seen = new Set();          // every recognition id ever detected
  var failedIds = new Set();
  var attempts = Object.create(null);     // id -> click attempts so far
  var notVisible = Object.create(null);   // id -> consecutive "not visible" skips
  var MAX_NOT_VISIBLE_SKIPS = 3;          // then retire it, so it can't stall end-of-feed

  var stats = { detected: 0, liked: 0, alreadyLiked: 0, skipped: 0, failed: 0, scrolls: 0 };

  var scrollContainer = null;
  var observer = null;
  var mutationSignal = 0;        // bumped whenever the feed inserts nodes
  var mutationWaiters = [];
  var logLines = [];

  /* ======================================================================
   * SMALL UTILITIES
   * ==================================================================== */
  function shallowClone(o) { var c = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k]; return c; }

  function scaled(ms) {
    var f = (Number(config.baseDelay) || 1000) / 1000;
    if (!isFinite(f) || f <= 0) f = 1;
    return Math.round(ms * f);
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function randDelay(range) { return scaled(Math.round(rand(range[0], range[1]))); }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms | 0)); });
  }

  /** Sleep that returns early if STOP is requested (emergency stop responsiveness). */
  function interruptibleSleep(ms) {
    var step = 100;
    var remaining = Math.max(0, ms | 0);
    return (function loop() {
      if (stopRequested || remaining <= 0) return Promise.resolve();
      var chunk = Math.min(step, remaining);
      remaining -= chunk;
      return sleep(chunk).then(loop);
    })();
  }

  function nowStamp() {
    var d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  function log(msg, level) {
    var line = '[' + nowStamp() + '] ' + msg;
    logLines.push(line);
    if (logLines.length > 200) logLines.shift();
    if (config.verbose || level === 'warn' || level === 'error') {
      var fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      try { console[fn]('[RecognizeAutoLiker] ' + msg); } catch (e) {}
    }
    renderLog();
  }

  /* ======================================================================
   * DOM HELPERS
   * ==================================================================== */
  function recognitionIdFromHref(href) {
    if (!href) return null;
    var m = String(href).match(RECOGNITION_HREF_RE);
    return m ? m[1] : null;
  }

  function recognitionIdOf(el) {
    if (!el) return null;
    // getAttribute keeps the raw relative href; .href would absolutize it, which
    // still matches, but the raw value is what we documented.
    return recognitionIdFromHref(el.getAttribute('href') || el.href || '');
  }

  function queryAll(selector, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
    catch (e) { return []; }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!rect || (rect.width <= 0 && rect.height <= 0)) return false;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
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
    if (el.dataset && el.dataset.busy === 'true') return false;
    return true;
  }

  /**
   * The safety gate. An element is clickable ONLY if every one of these holds.
   * Any doubt => not clicked.
   */
  function isSafeUnlikedTarget(el) {
    if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
    if (el.tagName !== 'A') return { ok: false, reason: 'not-an-anchor' };
    if (!el.matches(SELECTORS.UNLIKED)) return { ok: false, reason: 'selector-mismatch' };
    if (el.classList.contains('approved')) return { ok: false, reason: 'already-approved' };
    if (el.getAttribute('data-method') !== 'post') return { ok: false, reason: 'not-post-method' };
    if (el.getAttribute('data-category') !== 'recognition') return { ok: false, reason: 'not-recognition-category' };
    if (el.getAttribute('data-event') !== 'liked') return { ok: false, reason: 'not-liked-event' };
    var id = recognitionIdOf(el);
    if (!id) return { ok: false, reason: 'no-recognition-id-in-href' };
    if (!SAFE_ID_RE.test(id)) return { ok: false, reason: 'unsafe-recognition-id' };
    if (!isVisible(el)) return { ok: false, reason: 'not-visible' };
    if (!isEnabled(el)) return { ok: false, reason: 'disabled' };
    return { ok: true, id: id };
  }

  /** Container that actually holds/renders a recognition (used to re-find links). */
  function cardOf(el) {
    if (!el) return null;
    return el.closest('[data-recognition-id], .recognition, .recognition-card, li, article, .card, .feed-item') || el.parentElement;
  }

  /** Re-query an approval link by recognition id (never trust a stale ref). */
  function findApprovalById(id) {
    if (!id || !SAFE_ID_RE.test(id)) return null;
    var all = queryAll(SELECTORS.ANY);
    for (var i = 0; i < all.length; i++) {
      if (recognitionIdOf(all[i]) === id) return all[i];
    }
    return null;
  }

  function countRecognitionCards() {
    // Distinct recognitions currently rendered, measured by approval links —
    // the only element we know for certain exists once per recognition.
    var ids = new Set();
    queryAll(SELECTORS.ANY).forEach(function (a) {
      var id = recognitionIdOf(a);
      if (id) ids.add(id);
    });
    return ids.size;
  }

  /* ======================================================================
   * SCROLL CONTAINER DETECTION
   * We do NOT assume window.scrollTo() is right. We walk up from a real
   * recognition card and take the nearest genuinely scrollable ancestor.
   * ==================================================================== */
  function isScrollable(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    var oy = cs.overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
    return el.scrollHeight > el.clientHeight + 4;
  }

  function detectScrollContainer(force) {
    // A cached `window` means "no scrollable ancestor existed yet" — the feed
    // may have grown since, so always re-probe rather than trusting it.
    if (scrollContainer && scrollContainer !== window && !force && scrollContainer.isConnected) {
      return scrollContainer;
    }
    var anchor = document.querySelector(SELECTORS.ANY);
    var node = anchor ? cardOf(anchor) : null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollable(node)) { scrollContainer = node; return scrollContainer; }
      node = node.parentElement;
    }
    // Fall back to the document scroller (window scrolling).
    scrollContainer = window;
    return scrollContainer;
  }

  function scrollMetrics(c) {
    if (c === window || !c) {
      var se = document.scrollingElement || document.documentElement;
      return {
        top: window.pageYOffset || se.scrollTop || 0,
        height: se.scrollHeight,
        client: window.innerHeight || se.clientHeight
      };
    }
    return { top: c.scrollTop, height: c.scrollHeight, client: c.clientHeight };
  }

  function scrollBy(c, delta) {
    if (c === window || !c) {
      window.scrollBy(0, delta);
    } else {
      c.scrollTop = c.scrollTop + delta;
    }
  }

  function describeElement(el) {
    if (!el) return 'null';
    if (el === window) return 'window (document scrolling element)';
    var s = '<' + el.tagName.toLowerCase();
    if (el.id) s += ' id="' + el.id + '"';
    if (el.className && typeof el.className === 'string') s += ' class="' + el.className.trim().slice(0, 80) + '"';
    return s + '>';
  }

  /* ======================================================================
   * MUTATION OBSERVER — event-driven detection of newly inserted cards.
   * No aggressive polling loop: we wait on the observer + one timeout.
   * ==================================================================== */
  function startObserver() {
    if (observer) return;
    if (typeof MutationObserver === 'undefined') return;
    var target = document.body;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) {
          mutationSignal++;
          var waiters = mutationWaiters;
          mutationWaiters = [];
          waiters.forEach(function (w) { try { w(); } catch (e) {} });
          return;
        }
      }
    });
    try {
      observer.observe(target, { childList: true, subtree: true });
    } catch (e) {
      observer = null;
    }
  }

  function stopObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    mutationWaiters = [];
  }

  /**
   * Wait up to `ms` for the feed to insert nodes. Resolves as soon as the
   * observer fires (plus a short settle), or when the timeout expires.
   */
  function waitForFeedActivity(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(false);
      }, Math.max(0, ms | 0));
      mutationWaiters.push(function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Let the batch of inserted cards finish rendering before we scan.
        setTimeout(function () { resolve(true); }, scaled(400));
      });
    });
  }

  /* ======================================================================
   * CLICK + VERIFY
   * ==================================================================== */
  function isApprovedNow(id, previousEl) {
    var el = findApprovalById(id);
    if (!el) {
      // Element vanished entirely (feed re-render / removal). If the node we
      // clicked is gone and nothing unapproved replaced it, treat as unknown.
      if (previousEl && previousEl.isConnected && previousEl.classList.contains('approved')) return true;
      return null; // unknown
    }
    if (el.classList.contains('approved')) return true;
    if (el.classList.contains('unapproved')) return false;
    // Neither class: no longer matches the unliked selector => treat as done.
    return !el.matches(SELECTORS.UNLIKED);
  }

  function verifyApproved(id, clickedEl) {
    var deadline = Date.now() + scaled(config.verifyTimeoutMs);
    return (function poll() {
      var result = isApprovedNow(id, clickedEl);
      if (result === true) return Promise.resolve(true);
      if (Date.now() >= deadline) return Promise.resolve(result === null ? null : false);
      return sleep(scaled(config.verifyPollMs)).then(poll);
    })();
  }

  function performClick(el) {
    // Rails UJS (data-remote="true" + data-method="post") listens for a plain
    // click on the anchor. el.click() dispatches a trusted-shaped, bubbling
    // MouseEvent, which is exactly what the app's own handler expects.
    el.click();
  }

  /**
   * Record a skip. "not-visible" is normally transient (off-screen / lazy
   * render), so we retry it on later passes — but only a bounded number of
   * times, otherwise a permanently hidden card would keep the feed looking
   * "not exhausted" forever and the loop would never end.
   */
  function noteSkip(id, reason) {
    stats.skipped++;
    if (reason.indexOf('not-visible') === 0) {
      notVisible[id] = (notVisible[id] || 0) + 1;
      if (notVisible[id] >= MAX_NOT_VISIBLE_SKIPS) {
        processed.add(id);
        log('Retiring ' + id + ' — not visible after ' + notVisible[id] + ' passes.', 'warn');
      } else {
        log('Skip ' + id + ' (' + reason + ', pass ' + notVisible[id] + ')', 'warn');
      }
      return;
    }
    processed.add(id);
    log('Skip ' + id + ' (' + reason + ')', 'warn');
  }

  /**
   * Process a single recognition id. Returns one of:
   * 'liked' | 'already' | 'failed' | 'skipped'
   */
  function processRecognition(id) {
    var el = findApprovalById(id);
    if (!el) { stats.skipped++; processed.add(id); return Promise.resolve('skipped'); }

    if (el.matches(SELECTORS.LIKED)) {
      stats.alreadyLiked++;
      processed.add(id);
      return Promise.resolve('already');
    }

    var gate = isSafeUnlikedTarget(el);
    if (!gate.ok) {
      noteSkip(id, gate.reason);
      return Promise.resolve('skipped');
    }

    attempts[id] = (attempts[id] || 0) + 1;
    var attemptNo = attempts[id];

    if (config.scrollIntoViewBeforeClick) {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    }

    return interruptibleSleep(randDelay(config.preClickDelayRange)).then(function () {
      if (stopRequested) return 'skipped';

      // Re-query & re-gate: the feed may have changed during the delay.
      var fresh = findApprovalById(id);
      if (!fresh) {
        log('Recognition ' + id + ' disappeared before click.', 'warn');
        stats.skipped++;
        processed.add(id);
        return 'skipped';
      }
      if (fresh.matches(SELECTORS.LIKED)) {
        stats.alreadyLiked++;
        processed.add(id);
        return 'already';
      }
      var gate2 = isSafeUnlikedTarget(fresh);
      if (!gate2.ok) {
        noteSkip(id, gate2.reason + ' (re-check)');
        return 'skipped';
      }

      try {
        performClick(fresh);
      } catch (e) {
        log('Click threw for ' + id + ': ' + (e && e.message), 'error');
        stats.failed++;
        failedIds.add(id);
        processed.add(id);
        return 'failed';
      }

      return interruptibleSleep(randDelay(config.postClickDelayRange))
        .then(function () { return verifyApproved(id, fresh); })
        .then(function (ok) {
          if (ok === true) {
            stats.liked++;
            processed.add(id);
            log('Liked ' + id + ' (' + stats.liked + '/' + config.maxLikes + ')');
            return 'liked';
          }
          if (ok === null) {
            // Element vanished; we cannot confirm. Do not click again.
            log('Recognition ' + id + ' vanished during verification — counted as skipped.', 'warn');
            stats.skipped++;
            processed.add(id);
            return 'skipped';
          }
          if (attemptNo <= config.maxRetriesPerRecognition) {
            log('Still unapproved after click: ' + id + ' — one retry.', 'warn');
            return processRecognition(id); // exactly one retry, then give up
          }
          log('FAILED to like ' + id + ' after ' + attemptNo + ' attempts.', 'warn');
          stats.failed++;
          failedIds.add(id);
          processed.add(id);
          return 'failed';
        })
        .catch(function (e) {
          log('Verification error for ' + id + ': ' + (e && e.message), 'error');
          stats.failed++;
          failedIds.add(id);
          processed.add(id);
          return 'failed';
        });
    });
  }

  /* ======================================================================
   * SCAN
   * ==================================================================== */
  function scanFeed() {
    var unlikedIds = [];
    var likedIds = [];

    queryAll(SELECTORS.ANY).forEach(function (a) {
      var id = recognitionIdOf(a);
      if (!id) return;
      if (!seen.has(id)) { seen.add(id); stats.detected++; }
      if (processed.has(id)) return;
      if (a.matches(SELECTORS.UNLIKED)) unlikedIds.push(id);
      else if (a.matches(SELECTORS.LIKED)) likedIds.push(id);
    });

    // Count already-liked recognitions once each, then never revisit them.
    likedIds.forEach(function (id) {
      if (!processed.has(id)) { processed.add(id); stats.alreadyLiked++; }
    });

    return unlikedIds;
  }

  /* ======================================================================
   * MAIN LOOP
   * ==================================================================== */
  function waitWhilePaused() {
    if (state !== STATE.PAUSED) return Promise.resolve();
    return sleep(200).then(waitWhilePaused);
  }

  function reachedMax() { return stats.liked >= config.maxLikes; }

  function runLoop() {
    var noNewContent = 0;
    var lastCardCount = countRecognitionCards();
    var lastScrollHeight = scrollMetrics(detectScrollContainer()).height;

    function iteration() {
      if (stopRequested) return Promise.resolve('STOPPED');
      if (reachedMax()) return Promise.resolve('MAX_LIKES_REACHED');

      return waitWhilePaused().then(function () {
        if (stopRequested) return 'STOPPED';

        var batch = scanFeed();

        if (batch.length) {
          log('Found ' + batch.length + ' unliked recognition(s) in view.');
        }

        // Sequentially process the batch, honouring STOP / PAUSE / max between items.
        function nextItem(i) {
          if (i >= batch.length) return Promise.resolve(null);
          if (stopRequested) return Promise.resolve('STOPPED');
          if (reachedMax()) return Promise.resolve('MAX_LIKES_REACHED');
          return waitWhilePaused().then(function () {
            if (stopRequested) return 'STOPPED';
            if (reachedMax()) return 'MAX_LIKES_REACHED';
            if (processed.has(batch[i])) { stats.skipped++; return nextItem(i + 1); }
            return processRecognition(batch[i])
              .catch(function (e) {
                log('Unhandled error on ' + batch[i] + ': ' + (e && e.message), 'error');
                stats.failed++;
                processed.add(batch[i]);
                return null;
              })
              .then(function () { renderPanel(); return nextItem(i + 1); });
          });
        }

        return nextItem(0).then(function (early) {
          if (early) return early;
          if (stopRequested) return 'STOPPED';
          if (reachedMax()) return 'MAX_LIKES_REACHED';

          // ---- scroll for more ----
          var container = detectScrollContainer();
          var before = scrollMetrics(container);
          var frac = rand(config.scrollFractionRange[0], config.scrollFractionRange[1]);
          var delta = Math.max(120, Math.round(before.client * frac));
          scrollBy(container, delta);
          stats.scrolls++;

          return waitForFeedActivity(randDelay(config.postScrollDelayRange)).then(function () {
            var after = scrollMetrics(container);
            var cards = countRecognitionCards();
            var pending = scanFeed().length;

            var grewCards = cards > lastCardCount;
            var grewHeight = after.height > lastScrollHeight + 4;
            var moved = Math.abs(after.top - before.top) > 2;
            var atBottom = after.top + after.client >= after.height - 8;

            if (grewCards || grewHeight || pending > 0 || (moved && !atBottom)) {
              noNewContent = 0;
            } else {
              noNewContent++;
              log('No new content (' + noNewContent + '/' + config.maxNoNewContentAttempts + ')');
            }

            lastCardCount = Math.max(lastCardCount, cards);
            lastScrollHeight = Math.max(lastScrollHeight, after.height);

            if (noNewContent >= config.maxNoNewContentAttempts) {
              return 'END_OF_FEED';
            }
            renderPanel();
            return iteration();
          });
        });
      });
    }

    return iteration();
  }

  /* ======================================================================
   * DIAGNOSTIC MODE — reports only, clicks nothing.
   * ==================================================================== */
  function diagnose() {
    var unliked = queryAll(SELECTORS.UNLIKED);
    var liked = queryAll(SELECTORS.LIKED);
    var container = detectScrollContainer(true);
    var m = scrollMetrics(container);

    var ids = unliked.map(recognitionIdOf).filter(Boolean);
    var likedIds = liked.map(recognitionIdOf).filter(Boolean);
    var sampleHrefs = unliked.slice(0, 5).map(function (a) { return a.getAttribute('href'); });

    var report = {
      version: VERSION,
      unlikedCount: unliked.length,
      likedCount: liked.length,
      unlikedIds: ids,
      likedIds: likedIds,
      sampleHrefs: sampleHrefs,
      scrollContainer: container,
      scrollContainerDescription: describeElement(container),
      scrollHeight: m.height,
      viewportHeight: m.client,
      scrollTop: m.top,
      selectors: SELECTORS,
      containerStructure: unliked.length ? outlineAncestry(unliked[0]) : []
    };

    try {
      console.group('[RecognizeAutoLiker] DIAGNOSTIC (no clicks performed)');
      console.log('Unliked recognitions: ' + report.unlikedCount);
      console.log('Liked recognitions:   ' + report.likedCount);
      console.log('Feed scroll container:', container);
      console.log('Container description: ' + report.scrollContainerDescription);
      console.log('Current scroll height: ' + report.scrollHeight);
      console.log('Current viewport height: ' + report.viewportHeight);
      console.log('Current scroll top: ' + report.scrollTop);
      if (report.containerStructure.length) {
        console.log('Parent/container structure of first unliked link:');
        report.containerStructure.forEach(function (line, i) {
          console.log('  ' + new Array(i + 1).join('  ') + line);
        });
      }
      unliked.slice(0, 10).forEach(function (a) {
        console.log('Recognition ID: ' + recognitionIdOf(a) + '   Approval href: ' + a.getAttribute('href'));
      });
      if (unliked.length > 10) console.log('... and ' + (unliked.length - 10) + ' more');
      console.groupEnd();
    } catch (e) {}

    log('Diagnostic: ' + report.unlikedCount + ' unliked / ' + report.likedCount + ' liked, container ' + report.scrollContainerDescription);
    return report;
  }

  function outlineAncestry(el) {
    var chain = [];
    var node = el;
    var depth = 0;
    while (node && depth < 8 && node !== document.body) {
      chain.unshift(describeElement(node));
      node = node.parentElement;
      depth++;
    }
    return chain;
  }

  /* ======================================================================
   * CONTROLS
   * ==================================================================== */
  function resetCounters() {
    processed = new Set();
    seen = new Set();
    failedIds = new Set();
    attempts = Object.create(null);
    notVisible = Object.create(null);
    stats = { detected: 0, liked: 0, alreadyLiked: 0, skipped: 0, failed: 0, scrolls: 0 };
  }

  function start(overrides) {
    if (state === STATE.RUNNING) { log('Already running.'); return runPromise; }
    if (state === STATE.PAUSED) { return resume(); }

    if (overrides) setConfig(overrides);
    readPanelInputs();

    if (config.diagnostic) {
      log('DIAGNOSTIC MODE — scanning only, no clicks.');
      var report = diagnose();
      renderPanel();
      return Promise.resolve({ reason: 'DIAGNOSTIC', report: report, stats: shallowClone(stats) });
    }

    resetCounters();
    stopRequested = false;
    state = STATE.RUNNING;
    startObserver();
    detectScrollContainer(true);
    log('START — max likes ' + config.maxLikes + ', base delay ' + config.baseDelay + 'ms, container ' + describeElement(scrollContainer));
    renderPanel();

    runPromise = runLoop()
      .catch(function (e) {
        log('Fatal loop error: ' + (e && e.message), 'error');
        return 'ERROR';
      })
      .then(function (reason) {
        state = STATE.STOPPED;
        stopRequested = false;
        stopObserver();
        var result = { reason: reason || 'STOPPED', stats: shallowClone(stats) };
        api.lastResult = result;
        log('FINISHED (' + result.reason + ') — liked ' + stats.liked +
            ', already ' + stats.alreadyLiked + ', skipped ' + stats.skipped + ', failed ' + stats.failed);
        renderPanel();
        return result;
      });

    return runPromise;
  }

  function pause() {
    if (state !== STATE.RUNNING) return false;
    state = STATE.PAUSED;
    log('PAUSED — current operation will finish, no new clicks.');
    renderPanel();
    return true;
  }

  function resume() {
    if (state !== STATE.PAUSED) return false;
    state = STATE.RUNNING;
    log('RESUMED');
    renderPanel();
    // Deliberately NOT the run promise: awaiting resume() should not mean
    // "wait for the entire run to finish". Use waitForIdle() for that.
    return true;
  }

  function stop(reason) {
    if (state === STATE.STOPPED) { renderPanel(); return false; }
    stopRequested = true;          // checked before EVERY click
    state = STATE.STOPPING;
    log('STOP requested' + (reason ? ' (' + reason + ')' : '') + ' — no further clicks.');
    renderPanel();
    return true;
  }

  function setConfig(obj) {
    if (!obj) return getConfig();
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) config[k] = obj[k];
    }
    // Push into the panel too, otherwise start() would read the stale input
    // values straight back over the config we were just handed.
    syncPanelInputs();
    renderPanel();
    return getConfig();
  }

  function getConfig() { return shallowClone(config); }

  function waitForIdle() {
    return runPromise || Promise.resolve(api.lastResult || { reason: 'IDLE', stats: shallowClone(stats) });
  }

  /* ======================================================================
   * FLOATING CONTROL PANEL (Shadow DOM — cannot collide with app CSS)
   * ==================================================================== */
  var host = null, shadow = null, els = {};

  function buildPanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'recognize-auto-liker-host';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '.panel{font:12px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;width:230px;',
      'background:#1e2330;color:#e8ecf5;border:1px solid #39415a;border-radius:10px;',
      'box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden;}',
      '.hdr{background:#2a3346;padding:8px 10px;font-weight:700;cursor:move;display:flex;',
      'justify-content:space-between;align-items:center;user-select:none;}',
      '.hdr small{font-weight:400;opacity:.6;}',
      '.body{padding:10px;}',
      '.status{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:700;}',
      '.dot{width:9px;height:9px;border-radius:50%;background:#8a93a8;}',
      '.dot.RUNNING{background:#3ddc84;} .dot.PAUSED{background:#ffc857;}',
      '.dot.STOPPING{background:#ff8a5b;} .dot.STOPPED{background:#8a93a8;}',
      '.grid{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin-bottom:9px;}',
      '.grid span:nth-child(even){font-variant-numeric:tabular-nums;font-weight:700;}',
      '.muted{opacity:.72;font-weight:400 !important;}',
      'label{display:flex;justify-content:space-between;align-items:center;margin:5px 0;opacity:.9;}',
      'input[type=number]{width:74px;background:#141824;color:#e8ecf5;border:1px solid #39415a;',
      'border-radius:5px;padding:3px 6px;font:inherit;text-align:right;}',
      'input[type=checkbox]{accent-color:#ffc857;}',
      '.btns{display:flex;gap:6px;margin-top:9px;}',
      'button{flex:1;padding:6px 4px;border:0;border-radius:6px;font:inherit;font-weight:700;',
      'cursor:pointer;background:#39415a;color:#e8ecf5;}',
      'button:hover{filter:brightness(1.18);} button:disabled{opacity:.4;cursor:not-allowed;}',
      '.start{background:#2f8f5b;} .pause{background:#8a6d1f;} .stop{background:#a03a3a;}',
      '.diag{background:#2f5f8f;margin-top:6px;width:100%;}',
      '.log{margin-top:9px;max-height:92px;overflow:auto;background:#141824;border-radius:6px;',
      'padding:6px;font:10px/1.4 ui-monospace,Consolas,monospace;opacity:.85;white-space:pre-wrap;',
      'word-break:break-word;}',
      '.hint{margin-top:6px;font-size:10px;opacity:.55;text-align:center;}'
    ].join('');

    var wrap = document.createElement('div');
    wrap.className = 'panel';
    wrap.innerHTML = [
      '<div class="hdr" part="hdr">Recognize Auto Liker <small>v' + VERSION + '</small></div>',
      '<div class="body">',
      '  <div class="status"><span class="dot STOPPED" id="dot"></span><span id="state">STOPPED</span></div>',
      '  <div class="grid">',
      '    <span class="muted">Detected</span><span id="c-detected">0</span>',
      '    <span class="muted">Liked</span><span id="c-liked">0</span>',
      '    <span class="muted">Already liked</span><span id="c-already">0</span>',
      '    <span class="muted">Skipped</span><span id="c-skipped">0</span>',
      '    <span class="muted">Failed</span><span id="c-failed">0</span>',
      '  </div>',
      '  <label>Max likes <input type="number" id="in-max" min="1" step="1" value="500"></label>',
      '  <label>Delay (ms) <input type="number" id="in-delay" min="100" step="100" value="1000"></label>',
      '  <label>No-new-content stop <input type="number" id="in-nonew" min="1" step="1" value="5"></label>',
      '  <label>Diagnostic mode <input type="checkbox" id="in-diag"></label>',
      '  <div class="btns">',
      '    <button class="start" id="btn-start">START</button>',
      '    <button class="pause" id="btn-pause">PAUSE</button>',
      '    <button class="stop"  id="btn-stop">STOP</button>',
      '  </div>',
      '  <button class="diag" id="btn-diag">RUN DIAGNOSTIC (no clicks)</button>',
      '  <div class="log" id="log"></div>',
      '  <div class="hint">ESC = emergency stop</div>',
      '</div>'
    ].join('');

    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    var $ = function (id) { return shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector('#' + id); };
    els = {
      dot: $('dot'), state: $('state'),
      detected: $('c-detected'), liked: $('c-liked'), already: $('c-already'),
      skipped: $('c-skipped'), failed: $('c-failed'),
      max: $('in-max'), delay: $('in-delay'), nonew: $('in-nonew'), diag: $('in-diag'),
      start: $('btn-start'), pause: $('btn-pause'), stop: $('btn-stop'),
      diagBtn: $('btn-diag'), log: $('log'), hdr: wrap.querySelector('.hdr')
    };

    syncPanelInputs();

    els.start.addEventListener('click', function () { start(); });
    els.pause.addEventListener('click', function () {
      if (state === STATE.PAUSED) resume(); else pause();
    });
    els.stop.addEventListener('click', function () { stop('panel button'); });
    els.diagBtn.addEventListener('click', function () { diagnose(); });
    [els.max, els.delay, els.nonew, els.diag].forEach(function (i) {
      i.addEventListener('change', readPanelInputs);
    });

    makeDraggable(els.hdr, host);
    renderPanel();
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

  function syncPanelInputs() {
    if (!els.max) return;
    els.max.value = config.maxLikes;
    els.delay.value = config.baseDelay;
    els.nonew.value = config.maxNoNewContentAttempts;
    els.diag.checked = !!config.diagnostic;
  }

  function readPanelInputs() {
    if (!els.max) return;
    var max = parseInt(els.max.value, 10);
    var delay = parseInt(els.delay.value, 10);
    var nonew = parseInt(els.nonew.value, 10);
    if (isFinite(max) && max > 0) config.maxLikes = max;
    if (isFinite(delay) && delay >= 100) config.baseDelay = delay;
    if (isFinite(nonew) && nonew > 0) config.maxNoNewContentAttempts = nonew;
    config.diagnostic = !!els.diag.checked;
  }

  function renderPanel() {
    if (!els.state) return;
    els.state.textContent = state + (config.diagnostic ? ' (diagnostic)' : '');
    els.dot.className = 'dot ' + state;
    els.detected.textContent = stats.detected;
    els.liked.textContent = stats.liked;
    els.already.textContent = stats.alreadyLiked;
    els.skipped.textContent = stats.skipped;
    els.failed.textContent = stats.failed;
    els.start.disabled = (state === STATE.RUNNING);
    els.pause.textContent = (state === STATE.PAUSED) ? 'RESUME' : 'PAUSE';
    els.pause.disabled = (state === STATE.STOPPED || state === STATE.STOPPING);
    els.stop.disabled = (state === STATE.STOPPED);
  }

  function renderLog() {
    if (!els.log) return;
    els.log.textContent = logLines.slice(-40).join('\n');
    els.log.scrollTop = els.log.scrollHeight;
  }

  function showPanel() { if (!host) buildPanel(); host.style.display = ''; }
  function hidePanel() { if (host) host.style.display = 'none'; }

  /* ======================================================================
   * EMERGENCY STOP (ESC) — always wins, capture phase.
   * ==================================================================== */
  function onKeyDown(e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      if (state !== STATE.STOPPED) stop('ESC emergency stop');
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // A page refresh drops this script entirely, so automation always resets.
  window.addEventListener('beforeunload', function () { stopRequested = true; stopObserver(); });

  /* ======================================================================
   * EXPORT
   * ==================================================================== */
  var api = {
    __mounted: true,
    version: VERSION,
    SELECTORS: SELECTORS,
    STATE: STATE,
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    diagnose: diagnose,
    stats: function () { return shallowClone(stats); },
    processedIds: function () { return Array.from(processed); },
    failedIds: function () { return Array.from(failedIds); },
    setConfig: setConfig,
    getConfig: getConfig,
    waitForIdle: waitForIdle,
    showPanel: showPanel,
    hidePanel: hidePanel,
    detectScrollContainer: detectScrollContainer,
    log: log,
    lastResult: null
  };
  Object.defineProperty(api, 'state', { get: function () { return state; } });

  window[NS] = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }

  log('Recognize Auto Liker v' + VERSION + ' ready. Nothing clicked yet.');
  return api;
})();
