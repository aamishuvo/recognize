/*!
 * Mock RecognizeApp feed — shared by feed.html (manual) and test-runner.html.
 *
 * Reproduces the real DOM exactly, including the two things that make this
 * problem dangerous:
 *   1. the "+N" text is the TOTAL from all users, so an UNLIKED card can read
 *      "+4" and a LIKED one "+1";
 *   2. clicking an approved control really does DELETE the like — modelled
 *      faithfully, so a regression causes observable damage rather than only a
 *      logged complaint.
 */
(function (global) {
  'use strict';

  var approvalSeq = 15052256;

  /**
   * @param {HTMLElement} host  container to build into (emptied first)
   * @param {Object} cfg
   *   cards    [{ id, liked, count, behavior }]
   *            count  = approvals from OTHER users. A card with liked:true also
   *                     carries the current user's own approval, so its visible
   *                     total is count + 1 — which is exactly why the "+N" text
   *                     cannot be used to tell whether this user has liked it.
   *            behavior = normal | fail | vanish
   *   batches  [[cardSpec, ...], ...]  loaded lazily as the feed is scrolled
   *   slow     ms before the like registers (default 40)
   *   loadDelay ms before a lazy batch is inserted (default 200)
   *   height   px height of the scroll container (default 320)
   */
  function build(host, cfg) {
    cfg = cfg || {};
    var slow = cfg.slow != null ? cfg.slow : 40;
    var loadDelay = cfg.loadDelay != null ? cfg.loadDelay : 200;
    var batches = (cfg.batches || []).slice();

    var counts = Object.create(null);
    var approvalIds = Object.create(null);
    var behaviors = Object.create(null);

    var mock = {
      clicks: Object.create(null),      // recognitionId -> times clicked
      order: [],
      totalClicks: 0,
      forbiddenClicks: [],              // anything that must never be clicked
      unlikedByAutomation: [],          // CATASTROPHIC: an existing like removed
      batchesLoaded: 0
    };

    host.innerHTML =
      '<nav class="topnav">' +
      '  <a href="/nav/home" class="nav_link">Home</a>' +
      '  <a href="/nav/profile" class="profile_link">My Profile</a>' +
      '  <a href="/nav/recognitions/new" class="btn">Give Recognition</a>' +
      // Same anchor class, WRONG category — must never be clicked.
      '  <a class="approval_link unapproved btn" data-category="comment" data-event="liked"' +
      '     data-remote="true" data-method="post" rel="nofollow"' +
      '     href="/banglalink.net/comments/cmt00001/approvals?approvers_limit=5" data-decoy="comment">+</a>' +
      // Right category, WRONG event.
      '  <a class="approval_link unapproved btn" data-category="recognition" data-event="commented"' +
      '     data-remote="true" data-method="post" rel="nofollow"' +
      '     href="/banglalink.net/recognitions/decoyev1/approvals?approvers_limit=5" data-decoy="event">+</a>' +
      '</nav>' +
      '<div class="feed-scroller"><ul class="recognition-feed"></ul>' +
      '<div class="loader" hidden>Loading more recognitions…</div></div>';

    var scroller = host.querySelector('.feed-scroller');
    var feed = host.querySelector('.recognition-feed');
    var loader = host.querySelector('.loader');
    scroller.style.cssText =
      'overflow-y:auto;height:' + (cfg.height || 320) + 'px;border:1px solid #d6dbe6;' +
      'border-radius:8px;padding:10px;background:#fff;';

    /* ------------------------------------------------------------ anchors */
    function unlikedAnchor(id) {
      var a = document.createElement('a');
      a.className = 'approval_link unapproved btn';
      // Populated even when the CURRENT user has not liked it, exactly like the
      // real app — so data-sender is not a state signal either.
      a.setAttribute('data-sender', 'ANayan@banglalink.net');
      a.setAttribute('data-category', 'recognition');
      a.setAttribute('data-event', 'liked');
      a.setAttribute('data-remote', 'true');
      a.setAttribute('rel', 'nofollow');
      a.setAttribute('data-method', 'post');
      a.setAttribute('href', '/banglalink.net/recognitions/' + id + '/approvals?approvers_limit=5');
      a.textContent = counts[id] > 0 ? '+' + counts[id] : '+';
      return a;
    }

    function likedAnchor(id) {
      var a = document.createElement('a');
      a.className = 'approval_link approved';
      a.setAttribute('data-sender', 'ANayan@banglalink.net');
      a.setAttribute('data-category', 'recognition');
      a.setAttribute('data-event', 'liked');
      a.setAttribute('data-remote', 'true');
      a.setAttribute('rel', 'nofollow');
      a.setAttribute('data-method', 'delete');
      if (!approvalIds[id]) approvalIds[id] = String(approvalSeq++);
      a.setAttribute('href',
        '/banglalink.net/recognitions/' + id + '/approvals/' + approvalIds[id] + '?approvers_limit=5');
      a.textContent = '+' + counts[id];
      return a;
    }

    function makeCard(spec) {
      var id = spec.id;
      counts[id] = (spec.count != null ? spec.count : 0) + (spec.liked ? 1 : 0);
      behaviors[id] = spec.behavior || 'normal';

      var li = document.createElement('li');
      li.className = 'recognition';
      li.setAttribute('data-recognition-id', id);
      li.style.cssText = 'border:1px solid #e2e6ef;border-radius:8px;padding:10px;margin-bottom:10px;list-style:none;';
      li.innerHTML =
        '<h3 style="margin:0 0 4px;font-size:14px;">Great work — ' + id + '</h3>' +
        '<div class="meta" style="font-size:12px;color:#66708a;margin-bottom:8px;">Teamwork</div>' +
        '<div class="actions" style="display:flex;gap:10px;align-items:center;">' +
        '  <span class="vote text-nowrap"></span>' +
        '  <a class="approval_link unapproved btn" data-category="comment" data-event="liked"' +
        '     data-remote="true" data-method="post" rel="nofollow" data-decoy="card-comment"' +
        '     href="/banglalink.net/comments/c' + id + '/approvals?approvers_limit=5">+</a>' +
        '  <a class="comment_link" href="/banglalink.net/recognitions/' + id + '/comments">Comment</a>' +
        '  <a class="profile_link" href="/banglalink.net/users/u_' + id + '">Profile</a>' +
        '</div>';
      li.querySelector('.vote').appendChild(spec.liked ? likedAnchor(id) : unlikedAnchor(id));
      if (spec.hidden) li.style.display = 'none';
      return li;
    }

    function addCards(specs) {
      var frag = document.createDocumentFragment();
      specs.forEach(function (s) { frag.appendChild(makeCard(s)); });
      feed.appendChild(frag);
    }

    /* ----------------------------------------- click behaviour (Rails UJS) */
    host.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a') : null;
      if (!a || !host.contains(a)) return;
      e.preventDefault();

      var isRecognitionApproval =
        a.classList.contains('approval_link') &&
        a.getAttribute('data-category') === 'recognition' &&
        a.getAttribute('data-event') === 'liked';

      if (!isRecognitionApproval) {
        mock.forbiddenClicks.push({
          reason: 'non-recognition-approval',
          decoy: a.getAttribute('data-decoy'),
          cls: a.className,
          href: a.getAttribute('href')
        });
        return;
      }

      var m = (a.getAttribute('href') || '').match(/\/recognitions\/([A-Za-z0-9_-]+)\/approvals/);
      var id = m ? m[1] : null;

      // Clicking an approved control issues the DELETE and REALLY removes the
      // like. Modelled for real so a regression is observable.
      if (a.getAttribute('data-method') === 'delete' || a.classList.contains('approved')) {
        mock.forbiddenClicks.push({ reason: 'clicked-already-approved', href: a.getAttribute('href') });
        if (id) {
          mock.unlikedByAutomation.push(id);
          counts[id] = Math.max(0, (counts[id] || 1) - 1);
          delete approvalIds[id];
          if (a.parentNode) a.parentNode.replaceChild(unlikedAnchor(id), a);
        }
        return;
      }

      if (!id) return;
      mock.clicks[id] = (mock.clicks[id] || 0) + 1;
      mock.totalClicks++;
      mock.order.push(id);

      var card = a.closest('li.recognition');
      var behavior = behaviors[id] || 'normal';

      setTimeout(function () {
        if (behavior === 'fail') return;                              // server error
        if (behavior === 'vanish') { if (card) card.remove(); return; }
        if (!a.parentNode) return;
        counts[id] = (counts[id] || 0) + 1;                           // 4 -> 5
        a.parentNode.replaceChild(likedAnchor(id), a);                // app replaces the node
      }, slow);
    }, true);

    /* ------------------------------------------------------ infinite feed */
    var loading = false;
    scroller.addEventListener('scroll', function () {
      if (loading || !batches.length) return;
      if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 120) return;
      loading = true;
      loader.hidden = false;
      setTimeout(function () {
        addCards(batches.shift());
        mock.batchesLoaded++;
        loading = false;
        loader.hidden = true;
      }, loadDelay);
    }, { passive: true });

    /* ------------------------------------------------------ instrumentation */
    mock.root = scroller;
    mock.host = host;

    mock.snapshot = function () {
      var out = Object.create(null);
      [].forEach.call(
        host.querySelectorAll('a.approval_link[data-category="recognition"][data-event="liked"]'),
        function (a) {
          var mm = (a.getAttribute('href') || '').match(/\/recognitions\/([A-Za-z0-9_-]+)\/approvals/);
          if (!mm) return;
          out[mm[1]] = {
            cls: a.className,
            method: a.getAttribute('data-method'),
            href: a.getAttribute('href'),
            text: a.textContent.trim()
          };
        });
      return out;
    };

    mock.unlikedCount = function () {
      return host.querySelectorAll(
        'a.approval_link.unapproved[data-category="recognition"][data-event="liked"][data-method="post"]').length;
    };
    mock.likedCount = function () {
      return host.querySelectorAll(
        'a.approval_link.approved[data-category="recognition"][data-event="liked"][data-method="delete"]').length;
    };
    mock.textOf = function (id) {
      var s = mock.snapshot();
      return s[id] ? s[id].text : null;
    };
    /** Simulates the feed flipping a card to liked underneath the automation. */
    mock.makeApproved = function (id) {
      var a = host.querySelector(
        'a.approval_link[data-category="recognition"][data-event="liked"][href*="/recognitions/' + id + '/approvals"]');
      if (!a || a.classList.contains('approved')) return false;
      counts[id] = (counts[id] || 0) + 1;
      a.parentNode.replaceChild(likedAnchor(id), a);
      return true;
    };
    mock.removeCard = function (id) {
      var el = feed.querySelector('li.recognition[data-recognition-id="' + id + '"]');
      if (el) { el.remove(); return true; }
      return false;
    };
    mock.addCards = addCards;

    addCards(cfg.cards || []);
    return mock;
  }

  /** Deterministic RecognizeApp-shaped ids: 8 lowercase alphanumerics. */
  function id(n) { return ('rgl' + ('00000' + n.toString(36)).slice(-5)).slice(0, 8); }

  global.MockFeed = { build: build, id: id };
})(typeof window !== 'undefined' ? window : this);
