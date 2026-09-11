/*!
 * Recognize Auto Liker — paginated feed runner
 * ---------------------------------------------------------------------------
 * The Recognize grid is not only an infinite scroll: it also exposes real
 * pagination (?page=N, a.next_page, div.pagination). That is a far better way
 * to work through a long history:
 *
 *   - each page loads a small, fresh DOM, so nothing bloats and nothing hangs;
 *   - progress is a page number, so a run can RESUME instead of starting over;
 *   - no scrolling through thousands of posts you have already liked.
 *
 * Because moving to the next page is a real navigation, the content script is
 * torn down and rebuilt each time. All progress therefore lives in
 * chrome.storage, and the runner picks itself back up on the next page load.
 *
 * No chrome.* calls here: storage and navigation are injected, so this file is
 * testable and stays a pure module like the engine.
 */
(function (global) {
  'use strict';

  var PAGE_PARAM = 'page';

  /* ===================================================================== */
  /* Reading the pagination out of the page                                */
  /* ===================================================================== */

  /**
   * @returns {{current:number, next:number|null, nextUrl:string|null,
   *            last:number|null, paginated:boolean}}
   */
  function parsePageInfo(doc, win) {
    var loc = (win && win.location) || (doc && doc.location) || {};
    var href = loc.href || '';
    var current = pageOf(href) || 1;

    var nextUrl = null;
    var next = null;

    // The rel/next_page link is authoritative: it already carries every filter
    // the user has applied, which a hand-built URL could easily drop.
    var link = safeQuery(doc, 'a.next_page[href], a[rel="next"][href], link[rel="next"][href]');
    if (link) {
      var raw = link.getAttribute('href');
      var n = pageOf(raw);
      // Only trust it if it really points forward.
      if (n && n > current) { nextUrl = absolute(raw, href); next = n; }
    }

    if (!nextUrl) {
      // Fall back to the highest page link that is greater than the current one.
      var best = null;
      safeAll(doc, '.pagination a[href], .pager a[href], a[href*="' + PAGE_PARAM + '="]')
        .forEach(function (a) {
          var p = pageOf(a.getAttribute('href'));
          if (p === current + 1 && (best === null || p < best.p)) best = { p: p, href: a.getAttribute('href') };
        });
      if (best) { nextUrl = absolute(best.href, href); next = best.p; }
    }

    var last = null;
    safeAll(doc, '.pagination a[href], .pager a[href]').forEach(function (a) {
      var p = pageOf(a.getAttribute('href'));
      if (p && (last === null || p > last)) last = p;
    });

    var paginated = !!(safeQuery(doc, '.pagination, .pager, a.next_page') || nextUrl);

    return { current: current, next: next, nextUrl: nextUrl, last: last, paginated: paginated };
  }

  /** Builds the URL for an arbitrary page, preserving every other parameter. */
  function urlForPage(href, page) {
    var hash = '';
    var base = String(href || '');
    var hashAt = base.indexOf('#');
    if (hashAt >= 0) { hash = base.slice(hashAt); base = base.slice(0, hashAt); }

    var qAt = base.indexOf('?');
    var path = qAt >= 0 ? base.slice(0, qAt) : base;
    var query = qAt >= 0 ? base.slice(qAt + 1) : '';

    var parts = query ? query.split('&') : [];
    var kept = [];
    var replaced = false;
    parts.forEach(function (pair) {
      if (!pair) return;
      var key = pair.split('=')[0];
      if (decodeURIComponent(key) === PAGE_PARAM) {
        if (!replaced) { kept.push(PAGE_PARAM + '=' + page); replaced = true; }
        return;
      }
      kept.push(pair);
    });
    if (!replaced) kept.push(PAGE_PARAM + '=' + page);

    return path + (kept.length ? '?' + kept.join('&') : '') + hash;
  }

  function pageOf(href) {
    if (!href) return null;
    var m = String(href).match(/[?&]page=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function absolute(href, base) {
    try { return new URL(href, base).href; } catch (e) { return href; }
  }

  function safeQuery(doc, sel) {
    try { return doc.querySelector(sel); } catch (e) { return null; }
  }
  function safeAll(doc, sel) {
    try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (e) { return []; }
  }

  /* ===================================================================== */
  /* Walking the pages                                                     */
  /* ===================================================================== */

  var STATE_KEY = 'pageRun';

  /**
   * @param deps
   *   doc, win      - the document/window to read
   *   storage       - { get(): Promise<state|null>, set(state): Promise, clear(): Promise }
   *   navigate      - fn(url) -> void, performs the real page change
   *   runEngine     - fn(settings) -> Promise<{reason, stats}>, one page's worth of work
   *   onUpdate      - fn(state) whenever progress changes
   *   log           - fn(message)
   */
  function createPageRunner(deps) {
    // Read the document and window lazily rather than capturing them. In the
    // extension each navigation builds a fresh content script so it would not
    // matter, but a runner that is reused across page changes must never keep
    // reading the page it started on.
    function doc() { return deps.doc; }
    function win() { return deps.win; }
    var storage = deps.storage;
    var navigate = deps.navigate;
    var runEngine = deps.runEngine;
    var onUpdate = deps.onUpdate || function () {};
    var log = deps.log || function () {};

    var MAX_SEEK_STEPS = 25;   // log2(1792) is ~11; this is a safety net, not a budget

    function blankState(settings) {
      return {
        active: true,
        mode: 'run',
        currentPage: null,
        furthestPage: null,
        startedAt: Date.now(),
        page: parsePageInfo(doc(), win()).current,
        pagesDone: 0,
        emptyPagesInARow: 0,
        totals: { newLikes: 0, alreadyLiked: 0, skipped: 0, errors: 0, scanned: 0 },
        settings: settings || {},
        lastReason: null
      };
    }

    /**
     * Begin a paginated run.
     *
     * settings.startAtPage jumps straight there instead of walking from
     * wherever the browser happens to be. That is the whole point of having
     * pagination: after 72 pages of history there is no reason to re-walk them.
     */
    function start(settings) {
      var info = parsePageInfo(doc(), win());
      var state = blankState(settings);

      var target = parseInt(settings && settings.startAtPage, 10);
      if (isFinite(target) && target > 0 && target !== info.current) {
        state.page = target;
        state.jumpedTo = target;
        log('Jumping straight to page ' + target + ' (currently on ' + info.current + ')');
        return storage.set(state).then(function () {
          onUpdate(state);
          navigate(urlForPage(win().location.href, target));
          return { navigating: true, state: state };
        });
      }

      log('Paginated run starting at page ' + state.page);
      return storage.set(state).then(function () {
        onUpdate(state);
        return workThisPage(state);
      });
    }

    /**
     * Find where the last run left off, without walking there.
     *
     * The feed is newest-first and the pages already worked through form a
     * block at the front, so the first page still holding something unliked can
     * be found by halving the range instead of visiting every page. About
     * eleven page loads for a feed of 1792 pages, rather than seventy-two.
     *
     * It is a starting point, not a guarantee: if an old post somewhere deep in
     * the history was never liked while newer ones were, the search can land
     * later than that post. The run then goes forward from wherever it lands,
     * and a lower "start from page" can always be set by hand.
     */
    function findStart(settings) {
      var info = parsePageInfo(doc(), win());
      if (!info.paginated || !info.last || info.last < 2) {
        log('No page range to search - starting here instead');
        return start(settings);
      }
      var state = blankState(settings);
      state.mode = 'seek';
      state.seek = { lo: 1, hi: info.last, probe: null, steps: 0 };
      log('Searching pages 1-' + info.last + ' for the first one with anything unliked');
      return stepSeek(state);
    }

    function stepSeek(state) {
      var seek = state.seek;

      if (seek.steps >= MAX_SEEK_STEPS) {
        log('Search took too many steps - starting at page ' + seek.lo);
        return beginRunAt(state, seek.lo);
      }
      if (seek.lo >= seek.hi) {
        log('First page with anything unliked: ' + seek.lo);
        state.foundStartPage = seek.lo;
        return beginRunAt(state, seek.lo);
      }

      seek.probe = Math.floor((seek.lo + seek.hi) / 2);
      seek.steps++;
      return storage.set(state).then(function () {
        onUpdate(state);
        navigate(urlForPage(win().location.href, seek.probe));
        return { navigating: true, state: state };
      });
    }

    /** Switch out of searching and start the real run at `page`. */
    function beginRunAt(state, page) {
      state.mode = 'run';
      state.page = page;
      state.resumeAt = page;
      return storage.set(state).then(function () {
        onUpdate(state);
        var here = parsePageInfo(doc(), win()).current;
        if (here !== page) {
          navigate(urlForPage(win().location.href, page));
          return { navigating: true, state: state };
        }
        return workThisPage(state);
      });
    }

    /** One probe of the search: did this page have anything left to like? */
    function continueSeek(state) {
      var unliked = 0;
      try { unliked = deps.countUnliked ? deps.countUnliked() : 0; } catch (e) { unliked = 0; }
      var seek = state.seek;
      var at = parsePageInfo(doc(), win()).current;

      if (unliked > 0) {
        seek.hi = at;               // something here: the answer is at or before it
        log('Page ' + at + ' still has ' + unliked + ' unliked - searching earlier');
      } else {
        seek.lo = at + 1;           // nothing here: the answer is after it
        log('Page ' + at + ' is fully liked - searching later');
      }
      return stepSeek(state);
    }

    /** Called on every page load: continue a run that is already in progress. */
    function resume() {
      return storage.get().then(function (state) {
        if (!state || !state.active) return null;

        if (state.mode === 'seek' && state.seek) {
          onUpdate(state);
          return continueSeek(state);
        }

        var here = parsePageInfo(doc(), win()).current;
        // Write down where we are BEFORE doing any work. If the tab hangs or is
        // closed mid-page, this is the number to restart from.
        state.currentPage = here;
        state.furthestPage = Math.max(state.furthestPage || 0, here);
        state.resumeAt = here;
        if (state.page !== here) {
          // The user navigated somewhere else themselves. Adopt where they are
          // rather than yanking the browser back, but keep the totals.
          log('Resuming on page ' + here + ' (run had recorded ' + state.page + ')');
          state.page = here;
        } else {
          log('Resuming paginated run on page ' + here);
        }
        onUpdate(state);
        return workThisPage(state);
      });
    }

    function stop(reason) {
      return storage.get().then(function (state) {
        if (!state) return null;
        state.active = false;
        state.lastReason = reason || 'STOPPED_BY_USER';
        return storage.set(state).then(function () {
          log('Paginated run stopped: ' + state.lastReason);
          onUpdate(state);
          return state;
        });
      });
    }

    function workThisPage(state) {
      var at = parsePageInfo(doc(), win()).current;
      state.currentPage = at;
      state.furthestPage = Math.max(state.furthestPage || 0, at);
      state.resumeAt = at;
      storage.set(state);          // fire and forget: survives a hang mid-page

      var pageSettings = {};
      Object.keys(state.settings || {}).forEach(function (k) { pageSettings[k] = state.settings[k]; });
      pageSettings.scrollForMore = false;          // one page at a time
      pageSettings.stopAfterConsecutiveAlreadyLiked = 0;   // meaningless per page
      pageSettings.limitToInitialSet = true;       // ignore anything the loader appends
      // Nothing may scroll: a scroll wakes the site's infinite loader and pulls
      // the following pages in, which is exactly what page mode exists to avoid.
      pageSettings.scrollIntoViewBeforeClick = false;
      pageSettings.pruneProcessedCards = false;    // pages are small; nothing to prune

      // Whatever is left of the overall like budget.
      var budget = state.settings.maxLikesPerRun;
      if (budget > 0) {
        var left = budget - state.totals.newLikes;
        if (left <= 0) return finish(state, 'MAX_LIKES_REACHED');
        pageSettings.maxLikesPerRun = left;
      }

      return runEngine(pageSettings).then(function (result) {
        var s = (result && result.stats) || {};
        state.totals.newLikes += s.newLikes || 0;
        state.totals.alreadyLiked += s.alreadyLiked || 0;
        state.totals.skipped += s.skipped || 0;
        state.totals.errors += s.errors || 0;
        state.totals.scanned += s.scanned || 0;
        state.pagesDone++;
        state.emptyPagesInARow = (s.newLikes || 0) > 0 ? 0 : state.emptyPagesInARow + 1;

        if (result && result.reason === 'STOPPED_BY_USER') return finish(state, 'STOPPED_BY_USER');

        var limit = state.settings.maxLikesPerRun;
        if (limit > 0 && state.totals.newLikes >= limit) return finish(state, 'MAX_LIKES_REACHED');

        var emptyLimit = state.settings.stopAfterEmptyPages;
        if (emptyLimit > 0 && state.emptyPagesInARow >= emptyLimit) {
          return finish(state, 'CAUGHT_UP');
        }

        var info = parsePageInfo(doc(), win());
        var nextUrl = info.nextUrl ||
          (info.last && info.current < info.last
            ? urlForPage(win().location.href, info.current + 1)
            : null);

        if (!nextUrl) {
          // Distinguish "the feed really ended" from "this page has no
          // pagination markup", because they need completely different fixes.
          if (!info.paginated) {
            log('No pagination found on this page - cannot move on. ' +
                'Is this the grid view the run started from?');
            return finish(state, 'NO_PAGINATION');
          }
          return finish(state, 'END_OF_FEED');
        }

        state.page = info.next || (info.current + 1);
        state.lastPageReached = info.current;
        state.resumeAt = state.page;
        log('Page ' + info.current + ' done (' + (s.newLikes || 0) + ' new). Moving to page ' + state.page);

        return storage.set(state).then(function () {
          onUpdate(state);
          navigate(nextUrl);       // the content script is torn down here
          return { navigating: true, state: state };
        });
      });
    }

    function finish(state, reason) {
      state.active = false;
      state.lastReason = reason;
      state.lastPageReached = parsePageInfo(doc(), win()).current;
      // Where a fresh run should pick up next time.
      state.resumeAt = reason === 'END_OF_FEED' ? state.lastPageReached : state.lastPageReached;
      return storage.set(state).then(function () {
        log('Paginated run finished (' + reason + ') after ' + state.pagesDone +
            ' page(s): ' + state.totals.newLikes + ' new like(s)');
        onUpdate(state);
        return { done: true, state: state };
      });
    }

    return {
      start: start,
      findStart: findStart,
      resume: resume,
      stop: stop,
      STATE_KEY: STATE_KEY
    };
  }

  global.RecognizePagination = {
    STATE_KEY: STATE_KEY,
    parsePageInfo: parsePageInfo,
    urlForPage: urlForPage,
    pageOf: pageOf,
    createPageRunner: createPageRunner
  };
})(typeof window !== 'undefined' ? window : this);
