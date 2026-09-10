#!/usr/bin/env node
/**
 * Recognize Auto Liker — automated test suite.
 *
 * Drives the real core engine against tests/mock/feed.html in a real Chromium
 * via Playwright. Nothing here touches RecognizeApp.
 *
 *   node tests/run-tests.cjs            (all tests)
 *   node tests/run-tests.cjs --headed   (watch it work)
 *   node tests/run-tests.cjs 4 8        (only tests #4 and #8)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'playwright'));
  } catch (e) {
    console.error('\nPlaywright is not installed. Run:  npm install\n');
    process.exit(1);
  }
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'src', 'recognize-auto-liker.js'), 'utf8');
const MOCK = 'file://' + path.join(ROOT, 'tests', 'mock', 'feed.html');

const HEADED = process.argv.includes('--headed');
const ONLY = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);

/* ---------------------------------------------------------------- helpers */
const results = [];
let browser;

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open the mock feed and inject the engine (panel + API), without starting it. */
async function openFeed(query = {}, viewport = { width: 900, height: 700 }) {
  const page = await browser.newPage({ viewport });
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  await page.goto(MOCK + (params.toString() ? '?' + params.toString() : ''));
  await page.waitForFunction(() => window.__mock && window.__mock.ready);
  await page.addScriptTag({ content: CORE });
  await page.waitForFunction(() => window.__RecognizeAutoLiker__ && window.__RecognizeAutoLiker__.__mounted);
  return page;
}

/** Start a run and wait for it to finish; returns {reason, stats}. */
async function runToCompletion(page, cfg) {
  return page.evaluate(async (c) => {
    const L = window.__RecognizeAutoLiker__;
    L.setConfig(c);
    return await L.start();
  }, cfg);
}

const mockState = (page) => page.evaluate(() => ({
  clicks: window.__mock.clicks,
  totalClicks: window.__mock.totalClicks,
  forbiddenClicks: window.__mock.forbiddenClicks,
  unlikedByAutomation: window.__mock.unlikedByAutomation,
  approvedIds: window.__mock.approvedIds,
  batchesLoaded: window.__mock.batchesLoaded,
  unlikedLeft: window.__mock.unlikedCount(),
  likedNow: window.__mock.likedCount()
}));

/** The one failure that must never happen: an existing like was removed. */
function assertNoLikesRemoved(m) {
  eq(m.unlikedByAutomation.length, 0,
    'NO existing like was ever removed (removed: ' + JSON.stringify(m.unlikedByAutomation) + ')');
  eq(m.forbiddenClicks.length, 0,
    'no approved/decoy control was clicked: ' + JSON.stringify(m.forbiddenClicks));
}

/** Fast timings so the suite runs in seconds while keeping every code path. */
const FAST = { baseDelay: 150, maxNoNewContentAttempts: 3, verbose: false };

/* ------------------------------------------------------------------ tests */
const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

test('1. Clicks unliked recognitions and verifies the state flips', async () => {
  const page = await openFeed({ cards: 6, pages: 0, likedEvery: 3, slow: 50 });
  const res = await runToCompletion(page, { ...FAST, maxLikes: 500 });
  const m = await mockState(page);

  eq(res.stats.liked, 4, 'four unliked recognitions were liked');
  eq(res.stats.alreadyLiked, 2, 'two were already liked');
  eq(res.stats.failed, 0, 'no failures');
  eq(res.stats.detected, 6, 'six recognitions detected');
  eq(m.unlikedLeft, 0, 'no unliked approval links remain in the DOM');
  eq(m.likedNow, 6, 'all six now render approved + data-method="delete"');
  assertNoLikesRemoved(m);

  // The exact documented transition, per recognition we clicked.
  const after = await page.evaluate(() => window.__mock.snapshot());
  for (const id of Object.keys(m.clicks)) {
    assert(after[id].cls.includes('approved') && !after[id].cls.includes('unapproved'),
      id + ' carries .approved and no longer .unapproved');
    eq(after[id].method, 'delete', id + ' flipped data-method post -> delete');
    assert(/\/approvals\/\d+/.test(after[id].href),
      id + ' href gained the approval id: ' + after[id].href);
  }
  await page.close();
});

test('2. Never clicks an already-approved recognition or any decoy control', async () => {
  const page = await openFeed({ cards: 9, pages: 0, likedEvery: 2, slow: 50 });
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('a.approval_link.approved[data-category="recognition"]')]
      .map((a) => a.getAttribute('href')));
  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);

  assertNoLikesRemoved(m);
  const clickedIds = Object.keys(m.clicks);
  for (const href of before) {
    const id = href.match(/\/recognitions\/([^/]+)\/approvals/)[1];
    assert(!clickedIds.includes(id), `already-liked ${id} was not clicked`);
  }
  // Decoy controls must be untouched.
  const decoys = await page.evaluate(() => ({
    comment: document.getElementById('decoy-comment-approval').className,
    event: document.getElementById('decoy-event').className
  }));
  assert(decoys.comment.includes('unapproved'), 'comment approval decoy untouched');
  assert(decoys.event.includes('unapproved'), 'wrong-event decoy untouched');
  eq(res.stats.alreadyLiked, before.length, 'already-liked count matches the DOM');
  await page.close();
});

test('3. Never clicks the same recognition twice (dedupe across re-scans)', async () => {
  const page = await openFeed({ cards: 8, pages: 2, perPage: 4, likedEvery: 0, slow: 50, loadDelay: 250 });
  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);

  const dupes = Object.entries(m.clicks).filter(([, n]) => n > 1);
  eq(dupes.length, 0, 'no recognition was clicked more than once: ' + JSON.stringify(dupes));
  eq(m.totalClicks, res.stats.liked, 'click count equals like count');
  await page.close();
});

test('4. Handles the dynamic / infinite feed and likes newly loaded cards', async () => {
  const page = await openFeed({ cards: 6, pages: 2, perPage: 4, likedEvery: 0, slow: 50, loadDelay: 300 });
  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);

  eq(m.batchesLoaded, 2, 'both dynamic batches were loaded by scrolling');
  eq(res.stats.detected, 14, 'detected the initial 6 plus 8 lazily loaded');
  eq(res.stats.liked, 14, 'liked every recognition including lazily loaded ones');
  eq(m.unlikedLeft, 0, 'nothing left unliked');
  await page.close();
});

test('5. Detects end of feed and stops on its own', async () => {
  // Enough initial cards that the feed actually overflows and can be scrolled.
  const page = await openFeed({ cards: 10, pages: 1, perPage: 4, likedEvery: 0, slow: 50, loadDelay: 250 });
  const t0 = Date.now();
  const res = await runToCompletion(page, { ...FAST, maxNoNewContentAttempts: 3 });
  const elapsed = Date.now() - t0;

  eq(res.reason, 'END_OF_FEED', 'terminated with END_OF_FEED');
  eq(res.stats.liked, 14, 'liked all 14 recognitions before stopping');
  assert(elapsed < 60000, 'terminated in bounded time (' + elapsed + 'ms)');
  await page.close();
});

test('6. STOP immediately prevents further clicks', async () => {
  const page = await openFeed({ cards: 40, pages: 0, likedEvery: 0, slow: 50 });
  await page.evaluate((c) => {
    const L = window.__RecognizeAutoLiker__;
    L.setConfig(c);
    window.__run = L.start();
  }, { ...FAST, baseDelay: 500, maxLikes: 500 });

  await wait(2500);
  const midway = await page.evaluate(() => window.__RecognizeAutoLiker__.stats().liked);
  assert(midway > 0, 'engine was actually liking before STOP (' + midway + ')');

  await page.evaluate(() => window.__RecognizeAutoLiker__.stop('test'));
  const res = await page.evaluate(() => window.__run);
  const clicksAtStop = (await mockState(page)).totalClicks;

  eq(res.reason, 'STOPPED', 'run ended with reason STOPPED');
  eq(await page.evaluate(() => window.__RecognizeAutoLiker__.state), 'STOPPED', 'state is STOPPED');
  assert(res.stats.liked < 40, 'stopped before finishing the feed (' + res.stats.liked + '/40)');

  await wait(1500);
  eq((await mockState(page)).totalClicks, clicksAtStop, 'no clicks happened after STOP');
  await page.close();
});

test('7. PAUSE halts new clicks and lets the current one finish; RESUME continues', async () => {
  const page = await openFeed({ cards: 40, pages: 0, likedEvery: 0, slow: 50 });
  await page.evaluate((c) => {
    const L = window.__RecognizeAutoLiker__;
    L.setConfig(c);
    window.__run = L.start();
  }, { ...FAST, baseDelay: 500, maxLikes: 500 });

  await wait(2500);
  await page.evaluate(() => window.__RecognizeAutoLiker__.pause());
  eq(await page.evaluate(() => window.__RecognizeAutoLiker__.state), 'PAUSED', 'state is PAUSED');

  await wait(1200);                                   // let the in-flight click settle
  const atPause = (await mockState(page)).totalClicks;
  await wait(2000);                                   // stay paused
  eq((await mockState(page)).totalClicks, atPause, 'no new clicks while PAUSED');

  await page.evaluate(() => window.__RecognizeAutoLiker__.resume());
  eq(await page.evaluate(() => window.__RecognizeAutoLiker__.state), 'RUNNING', 'state is RUNNING after resume');
  await wait(2500);
  assert((await mockState(page)).totalClicks > atPause, 'clicking continued after RESUME');

  await page.evaluate(() => window.__RecognizeAutoLiker__.stop('test cleanup'));
  await page.evaluate(() => window.__run);
  await page.close();
});

test('8. Click failure: one retry, then marked failed — never hammered', async () => {
  const page = await openFeed({ cards: 3, pages: 0, likedEvery: 0, slow: 50, fail: 'rgl00001' });
  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);

  eq(res.stats.failed, 1, 'exactly one failure recorded');
  eq(res.stats.liked, 2, 'the other two were liked');
  eq(m.clicks['rgl00001'], 2, 'failing recognition clicked exactly twice (1 attempt + 1 retry)');
  const failed = await page.evaluate(() => window.__RecognizeAutoLiker__.failedIds());
  eq(failed.join(','), 'rgl00001', 'failed id reported');
  await page.close();
});

test('9. Survives DOM elements disappearing (during and before the click)', async () => {
  // (a) card removed by the app in response to the click
  const page = await openFeed({ cards: 4, pages: 0, likedEvery: 0, slow: 50, vanish: 'rgl00002' });
  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);
  eq(m.clicks['rgl00002'], 1, 'vanishing recognition clicked once, never re-clicked');
  eq(res.stats.liked, 3, 'the surviving three were liked');
  assert(res.reason === 'END_OF_FEED' || res.reason === 'MAX_LIKES_REACHED', 'run completed cleanly: ' + res.reason);
  await page.close();

  // (b) card removed while the engine is in its pre-click delay
  const page2 = await openFeed({ cards: 2, pages: 0, likedEvery: 0, slow: 50 });
  await page2.evaluate((c) => {
    const L = window.__RecognizeAutoLiker__;
    L.setConfig(c);
    window.__run = L.start();
  }, { ...FAST, baseDelay: 1000 });
  await wait(200);
  eq(await page2.evaluate(() => window.__mock.removeCard('rgl00001')), true, 'removed the pending card');
  const res2 = await page2.evaluate(() => window.__run);
  const m2 = await mockState(page2);
  assert(!m2.clicks['rgl00001'], 'the removed recognition was never clicked');
  eq(res2.stats.liked, 1, 'the remaining recognition was still liked');
  assert(res2.stats.skipped >= 1, 'the vanished one was counted as skipped');
  await page2.close();
});

test('10. Respects the maximum-likes limit', async () => {
  const page = await openFeed({ cards: 20, pages: 0, likedEvery: 0, slow: 50 });
  const res = await runToCompletion(page, { ...FAST, maxLikes: 5 });
  const m = await mockState(page);

  eq(res.reason, 'MAX_LIKES_REACHED', 'stopped for the max-likes reason');
  eq(res.stats.liked, 5, 'liked exactly the configured maximum');
  eq(m.totalClicks, 5, 'exactly five clicks were dispatched');
  eq(m.unlikedLeft, 15, 'the rest were left untouched');
  await page.close();
});

test('11. Diagnostic mode reports without clicking anything', async () => {
  const page = await openFeed({ cards: 12, pages: 0, likedEvery: 3, slow: 50 });
  const res = await runToCompletion(page, { ...FAST, diagnostic: true });
  const m = await mockState(page);

  eq(res.reason, 'DIAGNOSTIC', 'reported diagnostic mode');
  eq(m.totalClicks, 0, 'diagnostic mode clicked nothing');
  eq(res.report.unlikedCount, 8, 'counted 8 unliked recognitions');
  eq(res.report.likedCount, 4, 'counted 4 liked recognitions');
  assert(res.report.scrollContainerDescription.includes('feed-scroller'),
    'found the real scroll container, not window: ' + res.report.scrollContainerDescription);
  assert(res.report.sampleHrefs[0].includes('/recognitions/'), 'reported example hrefs');
  assert(res.report.unlikedIds.length === 8 && /^[a-z0-9]+$/.test(res.report.unlikedIds[0]),
    'extracted recognition ids');
  assert(res.report.scrollHeight > res.report.viewportHeight, 'reported scroll and viewport heights');
  await page.close();
});

test('12. Safety: hidden controls are not clicked and the scroll container is the feed', async () => {
  const page = await openFeed({ cards: 12, pages: 0, likedEvery: 0, slow: 50, hidden: 1 });
  const container = await page.evaluate(() => {
    const el = window.__RecognizeAutoLiker__.detectScrollContainer(true);
    return el === window ? 'window' : el.id;
  });
  eq(container, 'feed-scroller', 'nearest scrollable ancestor detected (not window)');

  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);
  eq(res.stats.liked, 12, 'only the twelve visible recognitions were liked');
  eq(m.forbiddenClicks.length, 0, 'no forbidden clicks');
  const hiddenStillUnliked = await page.evaluate(() =>
    !!document.querySelector('li[data-hidden-case] a.approval_link.unapproved'));
  assert(hiddenStillUnliked, 'the display:none recognition was never clicked');
  assert(res.reason === 'END_OF_FEED', 'still terminated cleanly despite an unreachable card: ' + res.reason);
  await page.close();
});

test('13. Day-to-day idempotency: a second run never touches an existing like', async () => {
  const page = await openFeed({ cards: 12, pages: 0, likedEvery: 3, slow: 50 });

  // ---- Day 1: 8 unliked get liked, 4 were already liked ----
  const day1 = await runToCompletion(page, { ...FAST });
  eq(day1.stats.liked, 8, 'day 1 liked the 8 unliked recognitions');
  eq(day1.stats.alreadyLiked, 4, 'day 1 skipped the 4 already-liked ones');
  const clicksAfterDay1 = (await mockState(page)).totalClicks;
  const stateAfterDay1 = await page.evaluate(() => window.__mock.snapshot());
  eq(Object.keys(stateAfterDay1).length, 12, 'all 12 recognitions present');
  eq(Object.values(stateAfterDay1).every((v) => v.method === 'delete'), true,
    'every recognition is now in the approved/delete state');

  // ---- Day 2: same feed, everything already approved ----
  const day2 = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);
  const stateAfterDay2 = await page.evaluate(() => window.__mock.snapshot());

  eq(day2.stats.liked, 0, 'day 2 liked nothing');
  eq(day2.stats.alreadyLiked, 12, 'day 2 saw all 12 as already liked');
  eq(day2.stats.failed, 0, 'day 2 recorded no failures');
  eq(m.totalClicks, clicksAfterDay1, 'day 2 dispatched ZERO clicks');
  assertNoLikesRemoved(m);
  eq(JSON.stringify(stateAfterDay2), JSON.stringify(stateAfterDay1),
    'the feed is byte-for-byte unchanged after day 2 (approval ids intact)');
  eq(m.likedNow, 12, 'all 12 approvals survived the second run');
  await page.close();
});

test('14. The +N total is never used as the current user\'s liked state', async () => {
  const page = await openFeed({ cards: 12, pages: 0, likedEvery: 3, slow: 50 });
  const before = await page.evaluate(() => window.__mock.snapshot());

  // The fixture is built so the count actively misleads:
  eq(before['rgl00005'].text, '+7', 'rgl00005 is UNLIKED but shows a high +7');
  eq(before['rgl00003'].text, '+2', 'rgl00003 is LIKED but shows a low +2');
  eq(before['rgl0000b'].text, '+1', 'rgl0000b shows +1 yet is UNLIKED by this user');
  eq(before['rgl00008'].text, '+',  'rgl00008 shows a bare + (zero total)');
  // Same visible text, opposite required actions:
  eq(before['rgl00004'].text, '+4', 'rgl00004 shows +4 and is UNLIKED');
  eq(before['rgl00009'].text, '+4', 'rgl00009 shows the same +4 but IS LIKED');
  eq(before['rgl00004'].method, 'post', 'rgl00004 offers post');
  eq(before['rgl00009'].method, 'delete', 'rgl00009 offers delete');

  const res = await runToCompletion(page, { ...FAST });
  const m = await mockState(page);
  const after = await page.evaluate(() => window.__mock.snapshot());

  assertNoLikesRemoved(m);
  eq(res.stats.liked, 8, 'all 8 unliked recognitions were liked regardless of their counts');

  // High count but unliked -> clicked.
  eq(m.clicks['rgl00005'], 1, 'the "+7" unliked recognition was clicked');
  eq(after['rgl00005'].text, '+8', 'its total went 7 -> 8');
  // Text "+1" but unliked -> clicked.
  eq(m.clicks['rgl0000b'], 1, 'the "+1" unliked recognition was clicked');
  // Zero total -> clicked.
  eq(m.clicks['rgl00008'], 1, 'the "+" (no likes yet) recognition was clicked');
  // Low count but already liked -> untouched.
  assert(!m.clicks['rgl00003'], 'the "+2" already-liked recognition was NOT clicked');
  eq(after['rgl00003'].href, before['rgl00003'].href, 'its approval id is unchanged');
  eq(after['rgl00003'].text, '+2', 'its total is unchanged');
  // Identical "+4" text, opposite outcomes.
  eq(m.clicks['rgl00004'], 1, 'the unliked "+4" was clicked');
  assert(!m.clicks['rgl00009'], 'the liked "+4" was NOT clicked');
  eq(after['rgl00009'].href, before['rgl00009'].href, 'the liked "+4" approval id is unchanged');
  await page.close();
});

/* ------------------------------------------------------------------- main */
(async () => {
  browser = await chromium.launch({ headless: !HEADED });
  const selected = ONLY.length
    ? TESTS.filter((t) => ONLY.includes(parseInt(t.name, 10)))
    : TESTS;

  console.log('\nRecognize Auto Liker — test suite (' + selected.length + ' tests)\n');
  let failures = 0;

  for (const t of selected) {
    const started = Date.now();
    try {
      await t.fn();
      const ms = Date.now() - started;
      console.log('  \x1b[32mPASS\x1b[0m  ' + t.name + '  \x1b[90m(' + ms + 'ms)\x1b[0m');
      results.push({ name: t.name, ok: true });
    } catch (err) {
      failures++;
      console.log('  \x1b[31mFAIL\x1b[0m  ' + t.name);
      console.log('        ' + (err && err.message));
      results.push({ name: t.name, ok: false, error: err && err.message });
    }
  }

  await browser.close();
  console.log('\n' + (results.length - failures) + '/' + results.length + ' passed\n');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exit(1);
});
