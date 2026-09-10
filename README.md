# Recognize Auto Liker

A **local** browser automation tool that clicks the Like (`+`) approval control on
RecognizeApp recognition posts you have **not** already liked.

It runs entirely inside a browser tab **you** already opened and logged into.

### What it deliberately does NOT do

| Not implemented | Why |
| --- | --- |
| Login automation | You log in yourself, manually |
| Credential / password handling or storage | Never touched |
| Cookie extraction | Never read or exported |
| Authentication bypass | Never attempted |
| API token / direct API calls | It only clicks visible DOM elements |
| Persisting run state | A page refresh fully resets the automation |

It is a click assistant for a session a human already established — nothing more.

---

## 1. Architecture

**Primary: a self-contained script with three equivalent delivery wrappers, all built from one source file.**

```
src/recognize-auto-liker.js        <-- the single source of truth (the engine)
        |
        +--> userscript/recognize-auto-liker.user.js   (Tampermonkey)   <-- recommended
        +--> dist/console-snippet.js                   (DevTools paste) <-- zero-install fallback
        +--> dist/bookmarklet.txt                      (bookmarklet)    <-- one-click fallback
        +--> extension/                                (unpacked Chrome extension)
```

### Why this shape

Your corporate Chrome blocks some Chrome Web Store extensions, so the design
requirement is *"must still work when installation is blocked"*.

* **A DevTools console paste can never be blocked** by extension policy. It is the
  guaranteed-to-work path, so the engine is written as a single self-contained IIFE
  with no build step, no imports, no bundler, and no network fetches. Paste it, it runs.
* **Tampermonkey** is the best day-to-day experience (auto-loads on every page visit) —
  the same file, with a metadata header. If your Chrome allows it, use it.
* **The unpacked extension** is the fallback if Tampermonkey specifically is blocked but
  Developer-mode loading is not.
* **Playwright was rejected as the primary** because it drives a *separate* browser
  profile, which would immediately require solving login — exactly what you ruled out.
  Playwright is used here only for the **test suite**, against a local mock page.

Nothing in this project circumvents a corporate administrator restriction. If all
four delivery routes are blocked by policy, the correct answer is to ask IT, not to
work around it.

---

## 2. Files

| File | Purpose |
| --- | --- |
| `src/recognize-auto-liker.js` | The engine. Edit this one; everything else is generated. |
| `userscript/recognize-auto-liker.user.js` | Tampermonkey userscript (generated) |
| `dist/console-snippet.js` | Paste-into-DevTools build (generated) |
| `dist/bookmarklet.txt` | One-line `javascript:` bookmarklet (generated) |
| `extension/manifest.json` | Manifest V3 for the unpacked extension |
| `extension/core.js` | Content script (generated) |
| `tools/build.cjs` | Regenerates all four outputs from `src/` |
| `tests/mock/feed.html` | Mock RecognizeApp feed: 20 cards, liked + unliked, decoys, infinite scroll |
| `tests/run-tests.cjs` | Playwright suite — 14 tests against the mock |
| `package.json` | `npm run build` / `npm test` / `npm run mock` |

---

## 3. Install (Windows)

### Option A — Tampermonkey (recommended)

1. Install Tampermonkey in Chrome (Web Store) or Edge (Edge Add-ons — often allowed
   when the Chrome store is not).
2. Open the Tampermonkey dashboard → **Utilities** tab → **File** → choose
   `userscript\recognize-auto-liker.user.js` → **Install**.
   *(Or: Dashboard → `+` → delete the template → paste the whole file → Ctrl+S.)*
3. Open RecognizeApp. The **Recognize Auto Liker** panel appears at the top right.

### Option B — DevTools console (always works, zero install)

1. Open RecognizeApp in Chrome and log in manually.
2. Press `F12` → **Console** tab.
3. If Chrome shows the "Allow pasting" warning, type `allow pasting` and press Enter.
4. Open `dist\console-snippet.js` in Notepad, `Ctrl+A`, `Ctrl+C`.
5. Paste into the Console and press Enter. The panel appears.
6. Note: this lasts until you refresh or navigate. Re-paste after a reload.

### Option C — Bookmarklet

1. Chrome → `Ctrl+Shift+O` (Bookmark manager) → ⋮ → **Add new bookmark**.
2. Name: `Recognize Auto Liker`. URL: the entire single line from `dist\bookmarklet.txt`.
3. On RecognizeApp, click the bookmark. (Some sites' Content-Security-Policy can block
   bookmarklets; if nothing happens, use Option B.)

### Option D — Unpacked Chrome extension

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select the `extension\` folder.
3. Open RecognizeApp; the panel loads automatically on every visit.
   *(If your policy sets `ExtensionInstallBlocklist` / disables Developer mode, this
   option is unavailable — use Option B.)*

---

## 4. Run diagnostic mode (do this first)

Diagnostic mode **clicks nothing**. It only reports what it can see.

**From the panel:** click **RUN DIAGNOSTIC (no clicks)**, then open the console (`F12`)
for the full report. (Or tick **Diagnostic mode** and press **START** — it will scan and
stop without clicking.)

**From the console:**

```js
__RecognizeAutoLiker__.diagnose()
```

Reports:

```
[RecognizeAutoLiker] DIAGNOSTIC (no clicks performed)
  Unliked recognitions: 12
  Liked recognitions:   8
  Feed scroll container: <div id="feed-scroller">
  Current scroll height: 5840
  Current viewport height: 720
  Parent/container structure of first unliked link:
    <div id="feed-scroller"> > <ul id="recognition-feed"> > <li class="recognition"> > <span class="vote"> > <a class="approval_link unapproved btn">
  Recognition ID: rglauokd   Approval href: /banglalink.net/recognitions/rglauokd/approvals?approvers_limit=5
```

**If `Unliked recognitions: 0` while you can see unliked posts**, stop — the selector
needs adjusting for your tenant, and production mode would do nothing anyway.

---

## 5. Run production mode

1. Make sure diagnostic mode found a sane number of unliked recognitions.
2. Set **Max likes** (default `500`) and **Delay** (default `1000` ms).
3. Press **START**.

Or from the console:

```js
__RecognizeAutoLiker__.start({ maxLikes: 50, baseDelay: 1200 });
```

What it does per cycle: scan visible unliked approvals → wait 500–1200 ms → click →
wait 800–1800 ms → verify `.unapproved` became `.approved` → move on → scroll the feed
by 60–75% of its height → wait 1500–2500 ms for new cards → repeat.

**Delay** is a base value: every randomized window above scales with it, so
`2000` doubles all of them and `500` halves them.

It stops on its own when: **max likes** is reached, or the feed produces **no new
content 5 consecutive times** (configurable), or you press **STOP**.

---

## 6. Stop it

| Method | Effect |
| --- | --- |
| **STOP** button | Immediate. No further clicks are dispatched. |
| **`Esc`** key | Same as STOP — emergency stop, works from anywhere on the page. |
| **PAUSE** button | The in-flight click finishes and is verified; no new clicks start. Press **RESUME** to continue. |
| **Refresh / navigate** | Automation is destroyed entirely. Nothing persists. |
| Console | `__RecognizeAutoLiker__.stop()` / `.pause()` / `.resume()` |

STOP is checked before **every** click and inside every wait, so it takes effect within
about 100 ms rather than at the end of the current delay.

---

## 7. Configuration

Panel: **Max likes**, **Delay**, **No-new-content stop**, **Diagnostic mode**.
Everything else via console:

```js
__RecognizeAutoLiker__.setConfig({
  maxLikes: 500,
  baseDelay: 1000,               // ms; scales every randomized window below
  preClickDelayRange:   [500, 1200],
  postClickDelayRange:  [800, 1800],
  postScrollDelayRange: [1500, 2500],
  scrollFractionRange:  [0.60, 0.75],  // fraction of feed height per scroll
  maxNoNewContentAttempts: 5,          // end-of-feed threshold
  verifyTimeoutMs: 2500,               // budget to confirm .approved
  maxRetriesPerRecognition: 1,         // one retry, then mark failed
  scrollIntoViewBeforeClick: true,
  diagnostic: false,
  verbose: true
});

__RecognizeAutoLiker__.stats();        // { detected, liked, alreadyLiked, skipped, failed, scrolls }
__RecognizeAutoLiker__.processedIds(); // recognition ids already handled
__RecognizeAutoLiker__.failedIds();    // recognition ids that would not flip
```

---

## 8. Safety model — this is a "like if not already liked" tool, never a "toggle like" tool

Clicking an **already approved** control issues the `DELETE` and **removes your own
existing like**. That is the one failure mode that destroys data rather than merely
doing nothing, so it is guarded structurally, not by convention.

### The two states

| | Class | `data-method` | href | Action |
| --- | --- | --- | --- | --- |
| Not liked by you | `approval_link unapproved` | `post` | `/recognitions/<id>/approvals` | **CLICK** |
| Liked by you | `approval_link approved` | `delete` | `/recognitions/<id>/approvals/<approval_id>` | **NOTHING** |

### The `+N` number is NOT a liked-state signal

The number rendered inside the link (`+1`, `+4`, `+5`) is the **total approvals from all
users**. It says nothing about whether *you* liked the post — an unliked recognition can
read `+4`, and a liked one `+5`. The engine therefore **never reads the link's text** for
any decision. There is no `textContent` / `innerText` read anywhere in
`src/recognize-auto-liker.js` outside the control panel's own UI rendering; grep it.
`data-sender` is likewise not a signal — it is populated in both states.

Test 14 pins this down with a fixture built to mislead: two recognitions both showing
`+4`, one unliked and one liked. The unliked one must be clicked, the liked one must not.

### The hard gate

The **only** element ever clicked is one satisfying, on a **fresh DOM query taken
immediately before the click**, every one of:

* still attached to the document (`isConnected`)
* is an `<a>` tag
* class contains `approval_link`
* **does not** carry `.approved` and **does not** have `data-method="delete"` ← refuse first
* class contains `unapproved`
* `data-method === "post"`
* `data-category === "recognition"`
* `data-event === "liked"`
* the composed selector `SELECTORS.UNLIKED` also matches
* `href` matches `/recognitions/<id>/approvals` with `<id>` of `[A-Za-z0-9_-]+`
* visible: non-zero box, not `display:none` / `visibility:hidden` / `opacity:0` / `pointer-events:none`
* enabled: no `disabled`, no `aria-disabled="true"`, no `.disabled`

If **any** condition fails, or the element cannot be freshly re-verified, it is not clicked.

The gate runs **three** times: at scan time, again after the pre-click delay (the feed can
change in between), and a third time inside `performClick()` with **zero gap** before
`el.click()` — so no await, timer, retry or future refactor can slip work between the
check and the click. `performClick()` throws rather than clicking anything it cannot fully
verify, and it is the only place in the file that dispatches a click.

Comment approvals (`data-category="comment"`), wrong-event approvals, navigation, profile
links, recognition creation, and already-approved controls are all structurally excluded.

### The in-memory Set is secondary

The processed-ID `Set` is **duplicate protection only**. It is never the reason something
gets clicked — the live DOM state is authoritative, and the full gate above runs against a
fresh query regardless of what the Set says.

---

## 9. Idempotency and duplicate protection

Safe to run on the same feed every day. A recognition you liked previously is never
un-liked by a later run.

* Every recognition ID (parsed from the `href`) is stored in a `Set` once handled.
* Anything that *looks* approved — `.approved` **or** `data-method="delete"`, either
  signal alone — is counted as already liked and never clicked. An ambiguous or
  half-rendered element is skipped, not clicked.
* After a click, the engine **verifies the exact expected transition** rather than
  assuming: the same recognition must now match
  `a.approval_link.approved[data-category="recognition"][data-event="liked"][data-method="delete"]`
  and no longer match the unapproved selector. The `href` gaining `/approvals/<approval_id>`
  is logged as confirmation.
* If it did not transition, it retries **exactly once**, then marks it failed and moves on.
  There is no code path that clicks a recognition a third time.
* If the element vanished and the outcome cannot be proven, it is marked uncertain and
  skipped — never re-clicked.

Test 13 runs the engine twice over the same feed ("Day 1" / "Day 2") and asserts the
second run dispatches **zero** clicks and leaves the DOM byte-for-byte identical,
approval IDs included.

---

## 10. Testing

```bash
npm install          # installs Playwright
npx playwright install chromium
npm test             # 14 tests, headless
npm run test:headed  # watch it run
node tests/run-tests.cjs 4 8   # run individual tests
```

To eyeball the mock page by hand:

```bash
npm run mock         # http://localhost:8080/feed.html
```

then paste `dist/console-snippet.js` into its console.

Mock page URL parameters: `cards`, `pages`, `perPage`, `likedEvery`, `slow`,
`loadDelay`, `hidden`, `fail`, `vanish`.
Example: `feed.html?cards=20&pages=3&likedEvery=4&fail=rgl00002`

### Coverage

| # | Test |
| --- | --- |
| 1 | Clicks unliked recognitions and verifies the state flips |
| 2 | Never clicks an already-approved recognition or any decoy control |
| 3 | Never clicks the same recognition twice across re-scans |
| 4 | Handles the dynamic / infinite feed and likes newly loaded cards |
| 5 | Detects end of feed and stops on its own |
| 6 | STOP immediately prevents further clicks |
| 7 | PAUSE halts new clicks; RESUME continues |
| 8 | Click failure → one retry, then marked failed, never hammered |
| 9 | Survives DOM elements disappearing during *and* before the click |
| 10 | Respects the maximum-likes limit |
| 11 | Diagnostic mode reports without clicking anything |
| 12 | Hidden controls are not clicked; the real scroll container is detected |
| 13 | Day-to-day idempotency: a second run dispatches zero clicks and removes no like |
| 14 | The `+N` total is never used as the current user's liked state |

The mock **faithfully models the destructive delete**: clicking an approved control there
really does remove the like and decrement the count. So a regression causes observable
damage, and the suite reports exactly which likes were destroyed rather than merely noting
a rule violation. Every test asserts `unlikedByAutomation` is empty.

---

## 11. Troubleshooting

**Panel does not appear**
Console paste: check for a red error and that you typed `allow pasting` first.
Tampermonkey: confirm the script is enabled and `@match` covers your host — if your URL
is not `*.recognizeapp.com`, edit the `@match` line to your actual domain.

**`Unliked recognitions: 0` but you can see unliked posts**
Right-click a `+` button → Inspect → confirm the classes and `data-` attributes. If your
tenant renders something different, update `SELECTORS.UNLIKED` in
`src/recognize-auto-liker.js` and re-run `node tools/build.cjs`.

**It likes a few, then stops with `END_OF_FEED` too early**
The feed's lazy loading is slower than the wait. Raise the delay:
`setConfig({ baseDelay: 2000, maxNoNewContentAttempts: 8 })`.

**Scroll container detected as `window` but the feed does not move**
Diagnostic mode prints the container it chose. If it is wrong, override it — the engine
picks the nearest scrollable ancestor of a recognition card, so scroll the feed manually
once (so it has a scrollbar) and re-run `diagnose()`.

**Everything reports `failed`**
The clicks are firing but the server is not approving. Check the Network tab for failing
`POST /approvals` requests — that is a server/permission issue, not an automation issue.
Stop and check whether your account can like those posts at all.

**Counts look off / it re-likes after refresh**
Nothing is persisted by design. After a refresh the engine starts from zero and relies
on the DOM state (`.approved`) to know what is already liked — which is exactly correct.

**Clicks happen but nothing changes, and the console shows a Rails UJS error**
The app uses `data-remote="true"` (Rails UJS). The engine dispatches a real `click()` on
the anchor, which is what UJS listens for. If the app has not finished booting its JS,
wait for the feed to fully render before pressing START.

---

## 12. Known limitations

* The `href` is the only source of a recognition ID. A tenant that renders approvals
  without `/recognitions/<id>/approvals` in the href will be skipped by the safety gate
  (`no-recognition-id-in-href`) rather than clicked blindly.
* A "like" is only as confirmed as the DOM. If the app optimistically renders
  `.approved` + `data-method="delete"` before the server responds and the request later
  fails, the engine counts it as liked. It errs toward *not* clicking, which is the safe
  direction: the worst case is a missed like, never a deleted one.
* Server-side rate limiting is not detectable from the DOM. If likes silently stop
  applying, the engine reports `failed` — that is the signal to stop and back off.
* Console-paste mode does not survive a page refresh (by design).
* Only the first-level document is handled (`@noframes`); recognitions inside an iframe
  are not processed.
* The scroll heuristic assumes recognitions live in one scrollable container. A feed split
  across several independently scrolling panes would need the container chosen manually.
* This automates a social signal. Bulk-liking every post is visible to your colleagues and
  may be against your employer's policy — that judgement is yours, and `Max likes` exists
  so you can keep the run small and deliberate.
