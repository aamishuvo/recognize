#!/usr/bin/env node
/**
 * Headless wrapper around tests/mock/test-runner.html.
 *
 * The tests themselves live in that HTML file and run in any browser with no
 * tooling at all — this script just opens the same file in headless Chromium
 * so the suite can run in a terminal or CI. It is NOT needed to use or verify
 * the extension.
 *
 *   node tests/run-tests.cjs [--headed]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try global */ }
  try {
    return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
  } catch (e) {
    console.error('\nPlaywright not found. The browser suite needs no tooling:');
    console.error('just open tests/mock/test-runner.html in Chrome.\n');
    process.exit(1);
  }
}

const { chromium } = loadPlaywright();
const ROOT = path.resolve(__dirname, '..');
const RUNNER = 'file://' + path.join(ROOT, 'tests', 'mock', 'test-runner.html');

/** Removes block and line comments so source checks measure code, not prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** Source-level invariants that a behavioural test cannot prove. */
function staticChecks() {
  const engine = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'engine.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'content.js'), 'utf8');
  const findings = [];

  // Every .click() in the codebase must be the single gated one. Strip comments
  // first: this check is about executable code, not about prose describing it.
  const engineCode = stripComments(engine);
  const engineClicks = engineCode.match(/\.click\(\)/g) || [];
  if (engineClicks.length !== 1) {
    findings.push(`engine.js has ${engineClicks.length} .click() calls in code; exactly 1 (inside performClick) is allowed`);
  }
  if (!/function performClick\(el\) \{\s*\n\s*var g = gate\(el\);\s*\n\s*if \(!g\.ok\) throw/.test(engine)) {
    findings.push('performClick() no longer re-runs the gate immediately before clicking');
  }
  if (/\.click\(\)/.test(stripComments(content))) {
    findings.push('content.js dispatches a click of its own — all clicks must go through the engine');
  }

  // The engine must not gate on tab visibility or use frame callbacks.
  for (const bad of ['document.hidden', 'visibilityState', 'requestAnimationFrame']) {
    if (engine.includes(bad)) findings.push(`engine.js references ${bad}; background tabs must keep working`);
  }

  // No credential/cookie surface anywhere in the extension.
  const extFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|json|html)$/.test(entry.name)) extFiles.push(p);
    }
  })(path.join(ROOT, 'extension'));

  for (const file of extFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const bad of ['document.cookie', 'chrome.cookies', 'XMLHttpRequest', 'navigator.credentials']) {
      if (text.includes(bad)) findings.push(`${path.relative(ROOT, file)} references ${bad}`);
    }
    if (/\bfetch\s*\(/.test(text)) findings.push(`${path.relative(ROOT, file)} calls fetch()`);
  }

  // Message names must line up across popup <-> content <-> background.
  const popup = fs.readFileSync(path.join(ROOT, 'extension', 'popup.js'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(ROOT, 'extension', 'options.js'), 'utf8');
  const bg = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
  const wiring = [
    ['RAL_COMMAND', [popup, content], 'popup sends it, content receives it'],
    ['RAL_STATUS', [content, bg], 'content sends it, background caches it'],
    ['RAL_GET_CACHED_STATUS', [popup, bg], 'popup asks, background answers'],
    ['RAL_GET_DEFAULTS', [optionsJs, bg], 'options asks, background answers']
  ];
  for (const [name, sources, why] of wiring) {
    if (!sources.every((src) => src.includes(name))) findings.push(`message ${name} is not wired on both ends (${why})`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) findings.push('manifest is not MV3');
  for (const perm of manifest.permissions || []) {
    if (!['storage', 'alarms'].includes(perm)) findings.push(`unexpected permission: ${perm}`);
  }
  for (const host of manifest.host_permissions || []) {
    if (!host.includes('recognizeapp.com')) findings.push(`host permission beyond Recognize: ${host}`);
  }
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action.default_icon || {})
  ];
  for (const rel of referenced) {
    if (!fs.existsSync(path.join(ROOT, 'extension', rel))) findings.push(`manifest references missing file: ${rel}`);
  }

  // ---- iPhone / Safari feature (additive; the checks above are unchanged) ----
  const iosScriptPath = path.join(ROOT, 'iphone-safari', 'recognize-auto-liker.ios.js');
  if (!fs.existsSync(iosScriptPath)) {
    findings.push('iphone-safari/recognize-auto-liker.ios.js is missing (run: node tools/build-ios.cjs)');
  } else {
    const ios = fs.readFileSync(iosScriptPath, 'utf8');
    const iosCode = stripComments(ios);

    // Self-contained and safe for Safari's Run JavaScript on Web Page.
    for (const bad of ['chrome.runtime', 'chrome.storage', 'chrome.tabs', 'localStorage',
      'sessionStorage', 'indexedDB', 'XMLHttpRequest', 'document.cookie',
      'navigator.credentials', 'importScripts', 'require(']) {
      if (iosCode.includes(bad)) findings.push(`iOS script uses ${bad}; it must be self-contained and store nothing`);
    }
    if (/\bfetch\s*\(/.test(iosCode)) findings.push('iOS script calls fetch()');
    if (/src\s*=\s*["']https?:/.test(iosCode)) findings.push('iOS script loads an external resource');

    // The same single gated click as everywhere else.
    const iosClicks = iosCode.match(/\.click\(\)/g) || [];
    if (iosClicks.length !== 1) findings.push(`iOS script has ${iosClicks.length} .click() calls in code; exactly 1 is allowed`);

    // It must carry the CURRENT gate, not a stale copy.
    const gate = engine.slice(engine.indexOf('function safetyCheck'), engine.indexOf('function recognitionIdOf'));
    if (!ios.includes(gate)) findings.push('iOS script carries a stale safety gate (run: node tools/build-ios.cjs)');

    // It must release the Shortcut rather than hanging it.
    if (!iosCode.includes('completion(')) findings.push('iOS script never calls completion(); the Shortcut would hang');

    for (const rel of ['iphone-safari/generator.html', 'iphone-safari/README.md',
      'iphone-safari/shortcut-guide.md', 'iphone-safari/tests/mock-recognize.html',
      'iphone-safari/src/ios-panel.js']) {
      if (!fs.existsSync(path.join(ROOT, rel))) findings.push(`missing iPhone feature file: ${rel}`);
    }
  }

  // ---- the additive feature must not have disturbed anything existing ----
  for (const rel of ['extension/manifest.json', 'extension/background.js', 'extension/popup.js',
    'extension/options.js', 'extension/content/engine.js', 'extension/content/content.js',
    'src/standalone-panel.js', 'tools/build.cjs', 'tools/make-icons.cjs',
    'dist/console-snippet.js', 'dist/bookmarklet.txt',
    'userscript/recognize-auto-liker.user.js', 'tests/mock/feed.html',
    'tests/mock/mock-feed.js', 'tests/mock/test-runner.html']) {
    if (!fs.existsSync(path.join(ROOT, rel))) findings.push(`pre-existing file went missing: ${rel}`);
  }

  return findings;
}

/** Minimal chrome.* stub so popup.html / options.html can be driven headlessly. */
function chromeStub(tabUrl, opts) {
  return `(${function (url, o) {
    const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
    window.__msgs = [];
    window.__storage = { settings: o.settings || {}, history: o.history || {} };
    window.__tabUrl = url;
    window.__tabResponds = o.tabResponds;
    window.__tabStatus = o.tabStatus || null;
    window.__defaults = o.defaults;
    window.chrome = {
      runtime: {
        lastError: undefined,
        getManifest: () => ({ version: '2.0.0' }),
        openOptionsPage: () => window.__msgs.push({ type: 'OPEN_OPTIONS' }),
        sendMessage: (msg, cb) => {
          window.__msgs.push(clone(msg));
          let resp = null;
          if (msg.type === 'RAL_GET_DEFAULTS') resp = clone(window.__defaults);
          if (msg.type === 'RAL_GET_CACHED_STATUS') resp = clone(o.cachedStatus) || null;
          if (cb) { cb(resp); return undefined; }
          return Promise.resolve(resp);
        }
      },
      storage: {
        local: {
          get: (keys, cb) => {
            let out = {};
            if (keys === null || keys === undefined) out = clone(window.__storage);
            else if (typeof keys === 'string') out[keys] = clone(window.__storage[keys]);
            else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = clone(window.__storage[k]); });
            if (cb) { cb(out); return undefined; }
            return Promise.resolve(out);
          },
          set: (obj, cb) => {
            Object.assign(window.__storage, clone(obj));
            window.__msgs.push({ type: 'STORAGE_SET', obj: clone(obj) });
            if (cb) { cb(); return undefined; }
            return Promise.resolve();
          },
          remove: (key, cb) => {
            delete window.__storage[key];
            if (cb) { cb(); return undefined; }
            return Promise.resolve();
          }
        }
      },
      tabs: {
        query: () => Promise.resolve([{ id: 7, url: window.__tabUrl }]),
        sendMessage: (tabId, msg, cb) => {
          window.__msgs.push(Object.assign({ to: tabId }, clone(msg)));
          if (!window.__tabResponds) {
            window.chrome.runtime.lastError = { message: 'Receiving end does not exist' };
            if (cb) cb(undefined);
            window.chrome.runtime.lastError = undefined;
            return;
          }
          window.chrome.runtime.lastError = undefined;
          if (cb) cb({ ok: true, status: clone(window.__tabStatus), report: clone(o.report) });
        }
      }
    };
  }})(${JSON.stringify(tabUrl)}, ${JSON.stringify(opts)})`;
}

const DEFAULTS = {
  scrollAmount: 700, scrollDelay: 1500, clickDelay: 1200, maxLikesPerRun: 100,
  maxNoNewContentAttempts: 5, minClickDelay: null, maxClickDelay: null,
  verifyTimeout: 3000, historyFailureLimit: 3, showBadge: true, debug: false
};

async function uiChecks(browser) {
  const results = [];
  const check = (name, fn) => results.push({ name, fn });
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function openPopup(url, opts) {
    const page = await browser.newPage();
    await page.addInitScript(chromeStub(url, Object.assign({ defaults: DEFAULTS, settings: DEFAULTS }, opts)));
    await page.goto('file://' + path.join(ROOT, 'extension', 'popup.html'));
    await wait(250);
    return page;
  }

  check('popup on a Recognize tab enables the controls and shows live stats', async () => {
    const status = {
      available: true, state: 'RUNNING',
      stats: { scanned: 12, alreadyLiked: 4, newLikes: 7, skipped: 1, errors: 0, currentRecognitionId: 'rglad2rn' }
    };
    const page = await openPopup('https://banglalink.recognizeapp.com/feed', { tabResponds: true, tabStatus: status });
    eq(await page.textContent('#state'), 'RUNNING', 'state shown');
    eq(await page.textContent('#s-scanned'), '12', 'scanned');
    eq(await page.textContent('#s-already'), '4', 'already liked');
    eq(await page.textContent('#s-liked'), '7', 'new likes');
    eq(await page.textContent('#s-errors'), '0', 'errors');
    eq(await page.textContent('#current'), 'rglad2rn', 'current recognition id');
    eq(await page.getAttribute('#notice', 'hidden'), '', 'no warning notice');
    eq(await page.isDisabled('#stop'), false, 'STOP is available');
    await page.close();
  });

  check('popup START / PAUSE / STOP send the right commands to the tab', async () => {
    const status = { state: 'STOPPED', stats: {} };
    const page = await openPopup('https://recognizeapp.com/feed', { tabResponds: true, tabStatus: status });
    await page.click('#start');
    await page.evaluate(() => { window.__tabStatus = { state: 'RUNNING', stats: {} }; });
    await wait(150);
    await page.click('#pause');
    await wait(100);
    await page.click('#stop');
    await wait(100);
    const commands = await page.evaluate(() =>
      window.__msgs.filter((m) => m.type === 'RAL_COMMAND' && m.command !== 'STATUS').map((m) => m.command));
    eq(commands.join(','), 'START,PAUSE,STOP', 'commands dispatched in order');
    const targeted = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'RAL_COMMAND').every((m) => m.to === 7));
    eq(targeted, true, 'every command went to the active tab');
    await page.close();
  });

  check('popup refuses to act on a non-Recognize tab', async () => {
    const page = await openPopup('https://example.com/', { tabResponds: false });
    await wait(900);
    eq(await page.getAttribute('#notice', 'hidden'), null, 'a notice is shown');
    eq(await page.isDisabled('#start'), true, 'START is disabled');
    const sent = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'RAL_COMMAND' && m.command !== 'STATUS').length);
    eq(sent, 0, 'no command was sent');
    await page.close();
  });

  check('popup falls back to the cached status when the tab is unreachable', async () => {
    const page = await openPopup('https://recognizeapp.com/feed', {
      tabResponds: false,
      cachedStatus: { state: 'WAITING', stalled: true, stats: { newLikes: 3, scanned: 9, alreadyLiked: 2, skipped: 0, errors: 0 } }
    });
    await wait(900);
    eq(await page.textContent('#s-liked'), '3', 'cached stats rendered');
    eq((await page.textContent('#state')).includes('throttled'), true, 'throttling is reported honestly');
    await page.close();
  });

  check('options page loads defaults, clears history and restores defaults', async () => {
    const page = await browser.newPage();
    await page.addInitScript(chromeStub('https://recognizeapp.com/', {
      defaults: DEFAULTS,
      settings: Object.assign({}, DEFAULTS, { clickDelay: 2500, minClickDelay: 400 }),
      history: { rgl00001: { outcome: 'liked' }, rgl00002: { outcome: 'liked' } }
    }));
    await page.goto('file://' + path.join(ROOT, 'extension', 'options.html'));
    await wait(250);

    eq(await page.inputValue('#clickDelay'), '2500', 'stored setting loaded');
    eq(await page.inputValue('#minClickDelay'), '400', 'explicit min loaded');
    eq(await page.inputValue('#maxClickDelay'), '', 'blank max stays blank (derived)');
    eq((await page.textContent('#history-count')).includes('2'), true, 'history count shown');

    await page.fill('#minClickDelay', '');
    await page.dispatchEvent('#minClickDelay', 'change');
    await wait(150);
    const savedNull = await page.evaluate(() => window.__storage.settings.minClickDelay);
    eq(savedNull, null, 'clearing an explicit delay stores null so it is derived again');

    await page.click('#clear-history');
    await wait(150);
    eq(await page.evaluate(() => Object.keys(window.__storage.history).length), 0, 'history cleared');
    eq((await page.textContent('#history-count')).includes('0'), true, 'count refreshed');

    await page.click('#restore-defaults');
    await wait(150);
    eq(await page.inputValue('#clickDelay'), '1200', 'defaults restored');
    await page.close();
  });

  console.log('\nExtension UI wiring (popup / options with a stubbed chrome API)');
  let failed = 0;
  for (const r of results) {
    try {
      await r.fn();
      console.log('  \x1b[32mPASS\x1b[0m  ' + r.name);
    } catch (e) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  ' + r.name + '\n        ' + e.message);
    }
  }
  return failed;
}

/**
 * The console snippet and bookmarklet are the fallback for machines where
 * policy blocks unpacked extensions, so they get end-to-end coverage too:
 * pasted into a real page, exactly as a user would.
 */
async function standaloneChecks(browser) {
  const results = [];
  let failed = 0;
  const snippet = fs.readFileSync(path.join(ROOT, 'dist', 'console-snippet.js'), 'utf8');
  const bookmarklet = fs.readFileSync(path.join(ROOT, 'dist', 'bookmarklet.txt'), 'utf8').trim();
  const FEED = 'file://' + path.join(ROOT, 'tests', 'mock', 'feed.html');
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

  async function check(name, fn) {
    try { await fn(); results.push('  \x1b[32mPASS\x1b[0m  ' + name); }
    catch (e) { failed++; results.push('  \x1b[31mFAIL\x1b[0m  ' + name + '\n        ' + e.message); }
  }

  await check('console snippet mounts a panel and likes only unliked recognitions', async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(FEED);
    await page.waitForFunction(() => window.mock && window.mock.unlikedCount() > 0);

    await page.evaluate(snippet);            // exactly what a user pastes

    const panel = await page.evaluate(() => {
      const host = [...document.documentElement.children].find((e) => e.shadowRoot && e.shadowRoot.querySelector('.p'));
      return host ? [...host.shadowRoot.querySelectorAll('button')].map((b) => b.textContent.trim()) : null;
    });
    eq(JSON.stringify(panel), JSON.stringify(['START', 'PAUSE', 'STOP', 'RUN DIAGNOSTIC (no clicks)']), 'panel controls present');

    const diag = await page.evaluate(() => window.__RecognizeAutoLiker__.diagnose());
    eq(diag.scrollContainer.includes('feed-scroller'), true, 'found the real scroll container');

    const res = await page.evaluate(async () => await window.__RecognizeAutoLiker__.start(
      { clickDelay: 90, scrollDelay: 110, verifyTimeout: 900, scrollAmount: 240, maxNoNewContentAttempts: 3 }));
    const after = await page.evaluate(() => ({
      unliked: window.mock.unlikedCount(), liked: window.mock.likedCount(),
      clicks: window.mock.totalClicks, forbidden: window.mock.forbiddenClicks,
      removed: window.mock.unlikedByAutomation
    }));
    await page.close();

    eq(after.removed.length, 0, 'NO existing like was removed: ' + JSON.stringify(after.removed));
    eq(after.forbidden.length, 0, 'no forbidden click: ' + JSON.stringify(after.forbidden));
    eq(after.unliked, 0, 'nothing left unliked');
    eq(res.stats.newLikes, after.clicks, 'exactly one click per new like');
    eq(res.stats.newLikes + res.stats.alreadyLiked, res.stats.scanned, 'every scanned recognition accounted for');
    eq(after.liked, res.stats.scanned, 'all scanned recognitions end up liked');
    eq(errors.length, 0, 'no page errors: ' + errors.join('; '));
  });

  await check('bookmarklet payload mounts', async () => {
    const page = await browser.newPage();
    await page.goto(FEED);
    await page.waitForFunction(() => window.mock);
    await page.evaluate(decodeURIComponent(bookmarklet.replace(/^javascript:/, '')));
    const mounted = await page.evaluate(() => !!(window.__RecognizeAutoLiker__ && window.__RecognizeAutoLiker__.__mounted));
    await page.close();
    eq(mounted, true, 'the bookmarklet payload runs and mounts');
  });

  await check('the feed probe reports the feed and changes nothing', async () => {
    const probe = fs.readFileSync(path.join(ROOT, 'dist', 'feed-probe.js'), 'utf8');
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(FEED);
    await page.waitForFunction(() => window.mock && window.mock.unlikedCount() > 0);

    const before = await page.evaluate(() => ({
      unliked: window.mock.unlikedCount(), liked: window.mock.likedCount(),
      clicks: window.mock.totalClicks, html: document.body.innerHTML.length
    }));

    const out = await page.evaluate(probe);

    const after = await page.evaluate(() => ({
      unliked: window.mock.unlikedCount(), liked: window.mock.likedCount(),
      clicks: window.mock.totalClicks, html: document.body.innerHTML.length,
      forbidden: window.mock.forbiddenClicks.length,
      removed: window.mock.unlikedByAutomation.length
    }));
    await page.close();

    // Read-only is the whole point: it runs on the real feed before we trust it.
    eq(after.clicks, before.clicks, 'the probe clicked nothing');
    eq(after.unliked, before.unliked, 'it liked nothing');
    eq(after.liked, before.liked, 'it unliked nothing');
    eq(after.forbidden, 0, 'no forbidden interaction');
    eq(after.removed, 0, 'no like was removed');
    eq(after.html, before.html, 'it did not modify the page');
    eq(errors.length, 0, 'no page errors: ' + errors.join('; '));

    // And it actually reports something useful.
    eq(out.counts.recognitionsOnPage > 0, true, 'it counted the recognitions');
    eq(out.scrolling.container.includes('feed-scroller'), true,
      'it found the real scroll container: ' + out.scrolling.container);
    eq(typeof out.feedNavigation.anythingUsable, 'boolean', 'it reports whether the feed is jumpable');
    eq(/\/recognitions\/[A-Za-z0-9_-]+\/approvals/.test(out.sampleApprovalHref), true,
      'it reports a sample approval href');
  });

  await check('the generated builds match the current engine', async () => {
    const engine = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'engine.js'), 'utf8');
    const gate = engine.slice(engine.indexOf('function safetyCheck'), engine.indexOf('function recognitionIdOf'));
    eq(snippet.includes(gate), true, 'console-snippet.js carries the current safety gate (run: node tools/build.cjs)');
    const userscript = fs.readFileSync(path.join(ROOT, 'userscript', 'recognize-auto-liker.user.js'), 'utf8');
    eq(userscript.includes(gate), true, 'the userscript carries the current safety gate (run: node tools/build.cjs)');
  });

  console.log('\nStandalone fallbacks (console snippet / bookmarklet / userscript)');
  results.forEach((r) => console.log(r));
  return failed;
}

(async () => {
  console.log('\nStatic safety checks');
  const findings = staticChecks();
  if (findings.length) {
    findings.forEach((f) => console.log('  \x1b[31mFAIL\x1b[0m  ' + f));
  } else {
    console.log('  \x1b[32mPASS\x1b[0m  one gated .click(), no visibility gating, no credential/network surface, manifest intact');
  }

  const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('pageerror', (e) => console.log('  \x1b[31mpage error\x1b[0m ' + e.message));
  await page.goto(RUNNER);
  await page.waitForFunction(() => window.__testsDone === true, null, { timeout: 300000 });
  const out = await page.evaluate(() => window.__testResults);
  await page.close();
  const uiFailed = await uiChecks(browser);
  const standaloneFailed = await standaloneChecks(browser);

  // iPhone / Safari suite — the same HTML file a user opens on their phone.
  const iosPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const iosErrors = [];
  iosPage.on('pageerror', (e) => iosErrors.push(e.message));
  await iosPage.goto('file://' + path.join(ROOT, 'iphone-safari', 'tests', 'mock-recognize.html'));
  await iosPage.waitForFunction(() => window.__testsDone === true, null, { timeout: 300000 });
  const iosOut = await iosPage.evaluate(() => window.__testResults);
  await iosPage.close();

  console.log('\niPhone / Safari suite (iphone-safari/tests/mock-recognize.html, 390x844 touch)');
  iosOut.results.forEach((r) => {
    if (r.ok) console.log('  \x1b[32mPASS\x1b[0m  ' + r.name);
    else console.log('  \x1b[31mFAIL\x1b[0m  ' + r.name + '\n        ' + r.error);
  });
  iosErrors.forEach((e) => console.log('  \x1b[31mpage error\x1b[0m ' + e));

  await browser.close();

  console.log('\nBrowser suite (tests/mock/test-runner.html)');
  out.results.forEach((r) => {
    if (r.ok) console.log('  \x1b[32mPASS\x1b[0m  ' + r.name);
    else console.log('  \x1b[31mFAIL\x1b[0m  ' + r.name + '\n        ' + r.error);
  });

  const failed = out.failed + findings.length + uiFailed + standaloneFailed + iosOut.failed + iosErrors.length;
  console.log('\n' + (out.total - out.failed) + '/' + out.total + ' browser tests passed, ' +
    (iosOut.total - iosOut.failed) + '/' + iosOut.total + ' iPhone tests passed, ' +
    findings.length + ' static findings, ' + uiFailed + ' UI wiring failures, ' +
    standaloneFailed + ' standalone failures\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
