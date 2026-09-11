/*!
 * Recognize Auto Liker — background keep-alive
 * ---------------------------------------------------------------------------
 * Chrome deliberately slows down tabs you are not looking at: timer chains get
 * clamped to about once a second, and after roughly five minutes hidden to
 * about once a minute. That is why a run crawls when you switch tabs.
 *
 * This module is HONEST about what it does. It holds a Web Audio oscillator at
 * an inaudible volume. A tab that is producing audio is one Chrome keeps fully
 * awake and does not freeze or discard — so the run keeps its normal pace while
 * you work in another window.
 *
 * Be aware of the trade-off, which is why this is opt-in:
 *   - Chrome shows the little speaker icon on the tab.
 *   - The tab appears in Chrome's media controls.
 *   - It holds an audio output device open (harmless, but it is real).
 *
 * It is not a security bypass and it does not touch the page, the feed, or the
 * click-safety gate. It only keeps the tab awake. If you would rather not use
 * it, leave it off: the service-worker catch-up ping still stops a throttled
 * run from stalling, it is just slower.
 */
(function () {
  'use strict';

  if (window.__ralKeepAlive) return;

  var ctx = null;
  var osc = null;
  var gain = null;
  var active = false;
  var lastError = null;

  function supported() {
    return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  }

  function start() {
    if (active) return status();
    if (!supported()) {
      lastError = 'Web Audio is not available in this browser';
      return status();
    }
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctor();
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      // Inaudible, but genuinely non-zero: a muted graph may not register as
      // playback at all, which would defeat the whole point.
      gain.gain.value = 0.0015;
      osc.frequency.value = 220;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      active = true;
      lastError = null;

      // Autoplay policy: without a user gesture on the PAGE, the context starts
      // suspended. Clicking START in the popup is a gesture in the popup, not
      // here, so resume() may be refused until the page itself is touched.
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
        armGestureFallback();
      }
    } catch (e) {
      lastError = e && e.message;
      active = false;
    }
    return status();
  }

  /** Resume on the first real interaction with the page, once. */
  function armGestureFallback() {
    var events = ['pointerdown', 'keydown', 'touchstart'];
    function once() {
      events.forEach(function (t) { window.removeEventListener(t, once, true); });
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
    }
    events.forEach(function (t) { window.addEventListener(t, once, true); });
  }

  function stop() {
    try { if (osc) osc.stop(); } catch (e) {}
    try { if (ctx) ctx.close(); } catch (e) {}
    osc = null; gain = null; ctx = null;
    active = false;
    return status();
  }

  function status() {
    return {
      supported: supported(),
      active: active,
      // 'running' means Chrome is treating this tab as playing audio.
      // 'suspended' means the autoplay policy is still holding it back — the
      // user needs to click once anywhere on the Recognize page.
      audioState: ctx ? ctx.state : 'none',
      error: lastError
    };
  }

  window.__ralKeepAlive = { start: start, stop: stop, status: status, supported: supported };
})();
