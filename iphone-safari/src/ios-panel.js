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
