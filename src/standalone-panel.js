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
