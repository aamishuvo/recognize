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

  if (nav.anythingUsable) {
    console.log('%cLooks like this feed MIGHT be jumpable. Send the block above.',
      'color:#2f8f5b;font-weight:bold');
  } else {
    console.log('%cNo pagination or load-more control found — this feed can probably only be scrolled.',
      'color:#a07a2a;font-weight:bold');
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
