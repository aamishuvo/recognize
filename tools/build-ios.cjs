#!/usr/bin/env node
/**
 * Builds the iPhone / Safari feature. ADDITIVE: it reads the shared engine and
 * the iOS host and writes only into iphone-safari/. It touches nothing that
 * tools/build.cjs produces, and the Chrome extension is unaffected.
 *
 *   node tools/build-ios.cjs
 *
 * Outputs:
 *   iphone-safari/recognize-auto-liker.ios.js   self-contained script to paste
 *                                               into the Shortcut
 *   iphone-safari/generator.html                open in any browser to copy or
 *                                               download the script, with the
 *                                               Shortcut instructions inline
 *
 * The script is the SAME engine the Chrome extension runs, so the click-safety
 * gate exists in exactly one place in this repository.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const engine = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'engine.js'), 'utf8');
const iosHost = fs.readFileSync(path.join(ROOT, 'iphone-safari', 'src', 'ios-panel.js'), 'utf8');
const version = (engine.match(/var VERSION = '([^']+)'/) || [, '0.0.0'])[1];

const HEADER = `/*!
 * Recognize Auto Liker for iPhone / iOS Safari — v${version}
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
`;

const script = HEADER + engine + '\n' + iosHost;

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  console.log('  wrote ' + rel + '  (' + Math.round(content.length / 1024) + ' KB)');
}

write('iphone-safari/recognize-auto-liker.ios.js', script);

/* ------------------------------------------------------------ generator.html */
// The script is embedded as a JSON string so the page works from file:// on a
// phone or a desktop, with no server and no fetch().
const embedded = JSON.stringify(script);

const generator = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Recognize Auto Liker — iPhone Safari script</title>
<style>
  :root { --bg:#f6f8fb; --fg:#1d2433; --muted:#667089; --line:#e2e6ef;
          --accent:#2f6f4f; --chip:#fff; --warn:#7a4b00; --warnbg:#fff4e0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141821; --fg:#e8ecf5; --muted:#98a2ba; --line:#2c3446;
            --accent:#3ddc84; --chip:#1b212d; --warn:#ffd79a; --warnbg:#3a2c12; }
  }
  * { box-sizing: border-box; -webkit-text-size-adjust: 100%; }
  body { margin:0; padding:20px 16px calc(28px + env(safe-area-inset-bottom,0px));
         background:var(--bg); color:var(--fg);
         font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing:.05em;
       color: var(--muted); margin: 26px 0 10px; }
  p.sub { color: var(--muted); margin: 0 0 18px; }
  section { background: var(--chip); border:1px solid var(--line); border-radius:12px;
            padding:14px 16px; margin-bottom:14px; }
  label { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:10px 0; }
  label input { width:110px; min-height:40px; padding:5px 10px; text-align:right; font:inherit;
    font-size:16px; border:1px solid var(--line); border-radius:9px; background:var(--bg); color:var(--fg); }
  .btns { display:flex; flex-wrap:wrap; gap:9px; margin-top:6px; }
  button { flex:1 1 150px; min-height:48px; border:0; border-radius:11px; font:inherit;
    font-weight:700; font-size:15px; background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:var(--line); color:var(--fg); }
  textarea { width:100%; height:170px; margin-top:12px; padding:10px; font:11px/1.4 ui-monospace,Menlo,monospace;
    border:1px solid var(--line); border-radius:9px; background:var(--bg); color:var(--fg); }
  .flash { margin-top:10px; font-weight:600; color:var(--accent); min-height:20px; }
  .warn { background:var(--warnbg); color:var(--warn); border-radius:9px; padding:10px 12px;
          font-size:13px; margin-top:12px; }
  ol { padding-left: 22px; } ol li { margin: 7px 0; }
  code { background:var(--bg); padding:1px 6px; border-radius:4px; font-size:13px; }
  .safe { border-left: 3px solid var(--accent); padding-left: 12px; }
  .meta { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Recognize Auto Liker — iPhone</h1>
  <p class="sub">Generates a self-contained script for Safari's
     <strong>Run JavaScript on Web Page</strong> Shortcut action. No app, no
     extension, no server, no npm.</p>

  <section>
    <h2 style="margin-top:0">Settings baked into the script</h2>
    <label>Maximum new likes per run <input type="number" inputmode="numeric" id="maxLikesPerRun" value="50" min="1" step="1"></label>
    <label>Scroll amount, px (0 = auto) <input type="number" inputmode="numeric" id="scrollAmount" value="0" min="0" step="50"></label>
    <label>Scroll delay, ms <input type="number" inputmode="numeric" id="scrollDelay" value="1500" min="200" step="100"></label>
    <label>Click delay, ms <input type="number" inputmode="numeric" id="clickDelay" value="1200" min="200" step="100"></label>
    <p class="meta">All four are also adjustable in the on-page panel afterwards, so
       these are just the starting values.</p>
  </section>

  <section>
    <div class="btns">
      <button id="copy">Copy JavaScript</button>
      <button id="download" class="secondary">Download .js</button>
      <button id="show" class="secondary">Show script</button>
    </div>
    <div class="flash" id="flash"></div>
    <textarea id="out" readonly hidden spellcheck="false"></textarea>
    <div class="warn">
      On iPhone, tap <strong>Copy JavaScript</strong> and paste straight into the
      Shortcut. The script is about <span id="size">—</span> KB, so pasting takes a
      moment — that is normal.
    </div>
  </section>

  <section class="safe">
    <h2 style="margin-top:0">Safety</h2>
    <p style="margin:0">Only recognitions you have <strong>not</strong> liked are clicked —
       an element must be <code>approval_link unapproved</code> with
       <code>data-method="post"</code>, re-checked immediately before every click.
       Anything <code>approved</code> or <code>data-method="delete"</code> is never
       clicked, so an existing like can never be removed. The visible
       <code>+N</code> is the total from all users and is never used to decide
       anything. Nothing is transmitted anywhere; no credentials, cookies or tokens
       are read.</p>
  </section>

  <h2>How to create the iPhone Shortcut</h2>
  <section>
    <ol>
      <li>Tap <strong>Copy JavaScript</strong> above.</li>
      <li>Open the <strong>Shortcuts</strong> app and tap <strong>+</strong> to create a new shortcut.</li>
      <li>Add the action <strong>Run JavaScript on Web Page</strong>
          (search for “JavaScript”; on some iOS versions it sits under
          <em>Safari</em> or <em>Web</em>).</li>
      <li>Tap the script box, select the placeholder text, and <strong>Paste</strong>.</li>
      <li>Open the shortcut's <strong>details</strong> (the ⓘ or settings icon) and turn on
          <strong>Show in Share Sheet</strong>. If there is an input-type list, make sure
          <strong>Safari web pages</strong> (or <em>URLs</em>) is ticked.</li>
      <li>Name it, for example <em>Recognize Auto Liker</em>, and tap <strong>Done</strong>.</li>
      <li>In Safari, open RecognizeApp and <strong>log in normally</strong>, then open the feed.</li>
      <li>Tap the <strong>Share</strong> button, scroll to your shortcut and tap it.
          Allow it to run on the page if iOS asks.</li>
      <li>A panel appears at the bottom of the page. Tap <strong>START</strong>.</li>
    </ol>
    <p class="meta">iOS renames things between versions. If a name here does not match
       exactly, look for the nearest equivalent — the action you need is the one that
       runs JavaScript against the current Safari page.</p>
    <div class="warn">
      Keep the Safari tab open and on screen while it runs. iOS suspends background
      pages, so switching apps or locking the phone pauses the run; it continues when
      you come back. Nothing here can change that, and this feature does not claim to
      run in the background.
    </div>
  </section>
</main>

<script>
const SCRIPT = ${embedded};
const FIELDS = ['maxLikesPerRun', 'scrollAmount', 'scrollDelay', 'clickDelay'];
const $ = (id) => document.getElementById(id);

function generate() {
  const cfg = {};
  for (const f of FIELDS) {
    const v = parseInt($(f).value, 10);
    if (Number.isFinite(v) && v >= 0) cfg[f] = v;
  }
  // The iOS host reads this if present, so settings are preset without editing code.
  return 'window.__RAL_IOS_CONFIG__ = ' + JSON.stringify(cfg) + ';\\n' + SCRIPT;
}

function flash(msg) { $('flash').textContent = msg; setTimeout(() => { $('flash').textContent = ''; }, 4000); }

function refreshSize() { $('size').textContent = Math.round(generate().length / 1024); }
FIELDS.forEach((f) => $(f).addEventListener('change', refreshSize));
refreshSize();

$('copy').addEventListener('click', async () => {
  const text = generate();
  try {
    await navigator.clipboard.writeText(text);
    flash('Copied. Paste it into the Shortcut action.');
  } catch (e) {
    // Older iOS / non-secure contexts: fall back to a selected textarea.
    const ta = $('out');
    ta.hidden = false;
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    flash(ok ? 'Copied. Paste it into the Shortcut action.'
             : 'Copy failed — the script is shown below, select all and copy manually.');
  }
});

$('download').addEventListener('click', () => {
  const blob = new Blob([generate()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'recognize-auto-liker.ios.js';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  flash('Downloaded. On iPhone it lands in Files > Downloads.');
});

$('show').addEventListener('click', () => {
  const ta = $('out');
  ta.hidden = !ta.hidden;
  if (!ta.hidden) ta.value = generate();
  $('show').textContent = ta.hidden ? 'Show script' : 'Hide script';
});
</script>
</body>
</html>
`;

write('iphone-safari/generator.html', generator);
console.log('\niPhone/Safari feature built (engine v' + version + '). Nothing else was touched.\n');
