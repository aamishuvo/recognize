/*!
 * Recognize feed probe — read-only.
 *
 * Paste this whole file into the DevTools console on your RecognizeApp feed.
 * It CLICKS NOTHING and CHANGES NOTHING. It only looks at the page and prints
 * one block of text describing how the feed is built, so we can work out
 * whether it is possible to jump straight to a point in it instead of
 * scrolling all the way down every time.
 *
 * It reads no cookies, no tokens and no credentials, and sends nothing
 * anywhere. Copy the printed block and paste it back in the chat.
 */
(function () {
  'use strict';

  var UNLIKED = 'a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]';
  var LIKED = 'a.approval_link.approved[data-category="recognition"][data-event="liked"][data-method="delete"]';
  var ANY = 'a.approval_link[data-category="recognition"][data-event="liked"]';

  function all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  function describe(el) {
    if (!el) return 'null';
    if (el === window) return 'window';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (typeof el.className === 'string' ? el.className : '').trim();
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 4).join('.');
    return s;
  }

  var out = {};

  /* ---------------------------------------------------------- the feed */
  var anyLinks = all(ANY);
  out.counts = {
    recognitionsOnPage: anyLinks.length,
    notYetLikedByYou: all(UNLIKED).length,
    alreadyLikedByYou: all(LIKED).length
  };

  out.url = {
    href: location.href.split('#')[0],
    query: location.search || '(none)'
  };

  /* ------------------------------------------------- the scroll container */
  function card(el) {
    return el && el.closest(
      '[data-recognition-id], .recognition, .recognition-card, article, li, .card, .feed-item');
  }
  var scroller = null;
  var node = anyLinks.length ? card(anyLinks[0]) : null;
  while (node && node !== document.body && node !== document.documentElement) {
    var cs = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 4) {
      scroller = node;
      break;
    }
    node = node.parentElement;
  }
  var se = document.scrollingElement || document.documentElement;
  out.scrolling = {
    container: scroller ? describe(scroller) : 'window / document.scrollingElement',
    scrollHeight: scroller ? scroller.scrollHeight : se.scrollHeight,
    clientHeight: scroller ? scroller.clientHeight : window.innerHeight,
    scrollTop: scroller ? scroller.scrollTop : (window.pageYOffset || se.scrollTop)
  };

  /* ------------------------------------ can we jump into the feed at all? */
  var nav = { pageLinks: [], nextLinks: [], loadMoreControls: [], cursorAttributes: [], paginationContainers: [] };

  all('a[href*="page="], a[href*="per_page="], a[href*="offset="], a[href*="before="], a[href*="after="]')
    .slice(0, 10).forEach(function (a) {
      nav.pageLinks.push(a.getAttribute('href') + '   [' + describe(a) + ']');
    });

  all('a[rel="next"], link[rel="next"], [data-next-page], [data-next-url], [data-remote][href*="page"]')
    .slice(0, 6).forEach(function (el) {
      nav.nextLinks.push((el.getAttribute('href') || el.getAttribute('data-next-url') || '') + '   [' + describe(el) + ']');
    });

  all('a, button, div[role="button"]').forEach(function (el) {
    if (nav.loadMoreControls.length >= 6) return;
    var t = (el.textContent || '').trim().toLowerCase();
    if (!t || t.length > 40) return;
    if (/load more|show more|see more|view more|older|next page|load older/.test(t)) {
      nav.loadMoreControls.push('"' + t + '"   [' + describe(el) + ']' +
        (el.getAttribute('href') ? '  href=' + el.getAttribute('href') : ''));
    }
  });

  ['data-page', 'data-cursor', 'data-offset', 'data-last-id', 'data-oldest', 'data-before',
   'data-next', 'data-url', 'data-infinite-scroll', 'data-pagination'
  ].forEach(function (attr) {
    var el = document.querySelector('[' + attr + ']');
    if (el) nav.cursorAttributes.push(attr + '="' + (el.getAttribute(attr) || '').slice(0, 120) + '"   [' + describe(el) + ']');
  });

  all('.pagination, .pager, .paginate, [class*="paginat"], [class*="infinite"]')
    .slice(0, 6).forEach(function (el) { nav.paginationContainers.push(describe(el)); });

  nav.anythingUsable = !!(nav.pageLinks.length || nav.nextLinks.length ||
                          nav.loadMoreControls.length || nav.cursorAttributes.length ||
                          nav.paginationContainers.length);
  out.feedNavigation = nav;

  /* --------------------------- what the auto-liker would actually decide */
  // The pagination block is very often present but hidden once infinite scroll
  // takes over, so "I can't see page numbers" says nothing about whether
  // jumping works. This reports what the code sees, not what the eye sees.
  var pagBlock = document.querySelector('.pagination, .pager');
  var nextLink = document.querySelector('a.next_page[href], a[rel="next"][href]');

  function visibility(el) {
    if (!el) return '(not in the page at all)';
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var hidden = cs.display === 'none' || cs.visibility === 'hidden' ||
                 parseFloat(cs.opacity) === 0 || (r.width === 0 && r.height === 0);
    return hidden
      ? 'IN THE PAGE but hidden from view (display:' + cs.display + ', visibility:' +
        cs.visibility + ', size ' + Math.round(r.width) + 'x' + Math.round(r.height) + ')'
      : 'in the page and visible';
  }

  function pageOf(href) {
    var m = String(href || '').match(/[?&]page=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // A diagnostic must never throw, whatever the page's base URL looks like.
  function absolute(href) {
    if (!href) return null;
    try { return new URL(href, location.href).href; } catch (e) { return href; }
  }

  var currentPage = pageOf(location.href) || 1;
  var nextHref = nextLink ? nextLink.getAttribute('href') : null;
  var nextPage = pageOf(nextHref);

  out.whatTheAutoLikerSees = {
    paginationBlock: visibility(pagBlock),
    nextLink: nextLink ? visibility(nextLink) : '(no a.next_page / rel=next)',
    currentPage: currentPage,
    nextPageItWouldGoTo: nextPage,
    nextUrlItWouldUse: absolute(nextHref),
    canJumpToAPage: !!(pagBlock || nextLink || nav.pageLinks.length)
  };

  /* ------------------------------------------- filters that could narrow it */
  var filters = [];
  all('select, input[type="date"], [role="tab"], .nav-tabs a, .tab a').slice(0, 12).forEach(function (el) {
    var label = (el.getAttribute('name') || el.getAttribute('aria-label') ||
                 (el.textContent || '').trim().slice(0, 30) || describe(el));
    filters.push(label + '   [' + describe(el) + ']');
  });
  out.possibleFilters = filters;

  /* -------------------------------------------- a sample of the real markup */
  var sample = all(UNLIKED)[0] || anyLinks[0];
  out.sampleApprovalHref = sample ? sample.getAttribute('href') : '(none found)';
  out.sampleCardTag = sample ? describe(card(sample)) : '(none)';

  /* ------------------------------------------------------------- output */
  var text = JSON.stringify(out, null, 2);
  var banner = '===== RECOGNIZE FEED PROBE — copy everything between the lines =====';
  console.log('%c' + banner, 'font-weight:bold');
  console.log(text);
  console.log('%c===================== end of probe =====================', 'font-weight:bold');

  var w = out.whatTheAutoLikerSees;
  if (w.canJumpToAPage) {
    console.log('%cThis feed CAN be jumped into, whether or not you can see page numbers.',
      'color:#2f8f5b;font-weight:bold');
    console.log('%cTry it by hand right now: put this in the address bar and press Enter:',
      'font-weight:bold');
    console.log('%c' + urlForPage(location.href, 73), 'color:#2f6f8f');
    if (w.paginationBlock.indexOf('hidden') === 0 || w.paginationBlock.indexOf('IN THE PAGE but hidden') === 0) {
      console.log('%cNote: the page links exist but are hidden by the site\'s own CSS, ' +
        'which is why you cannot see them at the bottom. That does not stop the URL from working.',
        'color:#a07a2a');
    }
  } else {
    console.log('%cNo pagination found — this feed can probably only be scrolled.',
      'color:#a07a2a;font-weight:bold');
  }

  function urlForPage(href, page) {
    var base = String(href).split('#')[0];
    var qAt = base.indexOf('?');
    var path = qAt >= 0 ? base.slice(0, qAt) : base;
    var parts = qAt >= 0 ? base.slice(qAt + 1).split('&') : [];
    var kept = [], replaced = false;
    parts.forEach(function (pair) {
      if (!pair) return;
      if (pair.split('=')[0] === 'page') {
        if (!replaced) { kept.push('page=' + page); replaced = true; }
        return;
      }
      kept.push(pair);
    });
    if (!replaced) kept.push('page=' + page);
    return path + (kept.length ? '?' + kept.join('&') : '');
  }

  try {
    if (typeof copy === 'function') {
      copy(text);
      console.log('%cCopied to your clipboard. Just paste it in the chat.',
        'color:#2f8f5b;font-weight:bold');
    }
  } catch (e) { /* copy() only exists in DevTools */ }

  return out;
})();
