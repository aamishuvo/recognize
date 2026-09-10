# Recognize Auto Liker

Likes the RecognizeApp recognitions you have **not** liked yet, scrolling the feed as it
goes — and **never** removes a like you already gave.

Everything runs locally in a browser tab you already opened and logged into. No login
automation, no credentials, no cookies, no tokens, no backend.

---

## Two ways to run it

### 1. Chrome extension — the primary form

Pure Manifest V3. No Node, no npm, no build step, no server, no executable.

```
chrome://extensions → Developer mode → Load unpacked → select the `extension` folder
```

Then open RecognizeApp, log in normally, click the extension icon and press **START**.

**→ Full guide: [`extension/README.md`](extension/README.md)** — installation, permissions,
privacy, background/minimised behaviour, troubleshooting, limitations.

### 2. Standalone fallback — when unpacked extensions are blocked

> **Seeing `Extension installation is blocked by policy`?** That is your organisation's
> Chrome policy, and nothing here tries to override it. Use the console snippet below —
> it is the same engine, is not an extension, and is covered by the same tests. To see
> which policy is responsible, open `chrome://policy` and look for
> `ExtensionInstallBlocklist` / `ExtensionSettings`.
>
> **Quickest path:** open your Recognize feed → `F12` → **Console** → type
> `allow pasting` + Enter if Chrome asks → paste all of `dist/console-snippet.js` →
> Enter. A control panel appears at the top right. Press **RUN DIAGNOSTIC** first, then
> set *Max new likes* to 3–5 and press **START**. `Esc` stops it. Re-paste after a page
> reload.

Some corporate Chrome policies disable Developer mode. The same engine is also built into
a userscript, a console snippet and a bookmarklet:

| File | How to use it |
| --- | --- |
| `dist/console-snippet.js` | `F12` → Console → (type `allow pasting` if asked) → paste → Enter. Cannot be blocked by extension policy |
| `userscript/recognize-auto-liker.user.js` | Tampermonkey → Utilities → File → Install |
| `dist/bookmarklet.txt` | Paste the single line as a bookmark's URL |

These give a floating control panel instead of the popup. They are **generated from the
extension's engine** (`node tools/build.cjs`), so there is exactly one implementation of
the click-safety gate in this repository.

Nothing here circumvents an administrator restriction. If policy blocks every route, the
answer is to ask IT.

### 3. iPhone / iOS Safari — no app, no extension

Run it from an iPhone through a Shortcut, using Safari's **Run JavaScript on Web Page**
action. Open [`iphone-safari/generator.html`](iphone-safari/generator.html), tap
**Copy JavaScript**, paste it into the Shortcut, then run the Shortcut from Safari's
Share sheet on your Recognize feed and press **START** in the panel that appears.

**→ Full guide: [`iphone-safari/README.md`](iphone-safari/README.md)** ·
step-by-step Shortcut setup: [`iphone-safari/shortcut-guide.md`](iphone-safari/shortcut-guide.md)

iOS suspends pages that are not on screen, so this cannot run in the background and does
not claim to — keep the tab visible while it runs.

---

## The safety model in one page

**This is a "like if not already liked" tool. It is never a "toggle like" tool.**
Clicking an already-approved control sends the `DELETE` and removes your own like — the
one failure mode that destroys data instead of merely doing nothing.

| | Class | `data-method` | Action |
| --- | --- | --- | --- |
| Not liked by you | `approval_link unapproved` | `post` | **CLICK** |
| Liked by you | `approval_link approved` | `delete` | **NOTHING** |

**The "+N" text is the total from all users and is never read.** An unliked recognition
can show `+4` and a liked one `+5`; two recognitions can both show `+4` while one needs a
click and the other must never be touched. `data-sender` is populated in both states, so
it is not a signal either.

A click happens only for an element that passes the full gate on a **fresh DOM query taken
immediately before the click** — anchor, `approval_link`, **not** `approved`, **not**
`data-method="delete"`, `unapproved`, `recognition`, `liked`, `post`, the composed
selector, a parseable recognition ID, visible, enabled, inside a recognition container.

The gate runs **three times** per click: at scan, after the pre-click delay, and once more
inside `performClick()` with **zero gap** before `el.click()`. That function contains the
only `.click()` in the engine, and the test suite fails if a second one ever appears.

After clicking, the engine re-queries that recognition by ID and requires the exact
transition `unapproved + post` → `approved + delete`. Not transitioned? Exactly one
controlled retry, then it is an error and the run moves on.

The processed-ID history in `chrome.storage.local` is **bookkeeping and optimisation
only** — it can make the engine skip, never click. The DOM decides, every time.

---

## Testing — no tooling required

Open **`tests/mock/test-runner.html`** in Chrome. It runs the real engine against a mock
feed and reports 20 tests, including the mandatory Day 1 / Day 2 idempotency test.

The mock models the destructive delete faithfully: clicking an approved control there
really removes the like and decrements the count, so a regression causes observable damage
and the tests name exactly which likes were destroyed.

| # | Test |
| --- | --- |
| 1–2 | Unliked `+0` and unliked `+4` are clicked |
| 3–4 | Already liked `+1` and `+5` are not clicked |
| 5 | A previously liked recognition met again is never toggled off |
| 6 | The DOM flipping to approved mid-delay prevents the click |
| 7 | A recognition loaded after scrolling is detected and liked |
| 8 | The same recognition appearing twice is clicked once |
| 9–11 | PAUSE / RESUME, STOP, and `Esc` emergency stop |
| 12 | A hidden document does not stop the run |
| **13** | **Day 1 / Day 2 idempotency — A and B are never unliked** |
| 14 | Identical `+4` text, opposite actions |
| 15 | Decoy controls (comment approvals, nav, profile) are never clicked |
| 16–17 | Maximum new likes, end-of-feed detection |
| 18–19 | One retry then error; a vanishing card does not break the run |
| 20 | The gate rejects every never-click shape |

To run the same suite headlessly (optional, developer-only):

```bash
npm install && node tests/run-tests.cjs
```

That adds two layers on top of the browser suite: **static safety checks** (exactly one
gated `.click()`, no `document.hidden` / `visibilityState` / `requestAnimationFrame` in
the engine, no `fetch` / `XMLHttpRequest` / `document.cookie` / `chrome.cookies` anywhere
in `extension/`, minimal permissions, every manifest reference exists, message names wired
on both ends) and **UI wiring checks** that drive `popup.html` and `options.html` against
a stubbed `chrome` API.

`tests/mock/feed.html` is a browsable mock feed for poking at by hand.

The iPhone feature has its own 18-test suite at
[`iphone-safari/tests/mock-recognize.html`](iphone-safari/tests/mock-recognize.html),
also tooling-free, which runs the generated script and includes its own Day 1 / Day 2
idempotency test. `node tests/run-tests.cjs` runs it too, at a 390×844 touch viewport.

---

## Project layout

```
extension/              The Chrome extension — load this folder unpacked
  content/engine.js     The automation engine and the ONLY safety gate
  content/content.js    Chrome glue: messaging, storage, Esc, on-page badge
  background.js         MV3 service worker: defaults, status cache, watchdog
  popup.*  options.*    Dashboard and settings
  icons/                Generated by tools/make-icons.cjs (committed)
  README.md             Full extension guide

src/standalone-panel.js Floating-panel host for the non-extension builds
userscript/  dist/      Generated fallbacks (node tools/build.cjs)

tests/mock/mock-feed.js    Mock feed, shared by the manual page and the suite
tests/mock/test-runner.html The 20-test suite — open it in any browser
tests/mock/feed.html       Browsable mock feed
tests/run-tests.cjs        Headless wrapper + static and UI checks (dev-only)

iphone-safari/          iPhone / iOS Safari feature
  generator.html        Copy / download the script, with the Shortcut guide inline
  recognize-auto-liker.ios.js  Generated self-contained script for the Shortcut
  src/ios-panel.js      iOS host: mobile panel + Shortcuts completion() handling
  tests/mock-recognize.html    18-test suite — open in any browser, phone included
  README.md  shortcut-guide.md

tools/build.cjs         Rebuilds the standalone fallbacks from the engine
tools/build-ios.cjs     Rebuilds the iPhone feature (writes only into iphone-safari/)
tools/make-icons.cjs    Regenerates the PNG icons (dev-only)
```

All four delivery forms are built from the one engine in
`extension/content/engine.js`, so the click-safety gate exists in exactly one place.

Documentation in Bangla: [`README.bn.md`](README.bn.md).

---

## Known limitations

* **Background execution is not guaranteed**, and this project does not claim otherwise.
  Chrome throttles timers in hidden tabs, so a minimised run continues but slowly; the
  popup reports that as `RUNNING (throttled)`. Sleep, hibernation, closing Chrome or a
  discarded tab all stop it. Nothing here tries to defeat Chrome's throttling.
  Leave the tab visible for a fast, dependable run.
* A "like" is only as confirmed as the DOM. If the app optimistically renders
  `approved` + `delete` before the server responds and the request later fails, the
  engine counts it as liked. It errs toward *not* clicking: the worst case is a missed
  like, never a deleted one.
* Server-side rate limiting is invisible from the DOM. If likes silently stop applying,
  the engine reports errors — that is the signal to stop and back off.
* The recognition ID comes only from the `href`. A tenant that renders approvals without
  `/recognitions/<id>/approvals` is skipped by the gate rather than clicked blindly.
* Only the top-level document is handled; recognitions inside an iframe are not processed.
* The scroll heuristic assumes recognitions live in one scrollable container. A feed split
  across several independently scrolling panes would need the container chosen manually.
* This automates a social signal. Bulk-liking is visible to your colleagues and may be
  against your employer's policy — that judgement is yours, which is why **Maximum new
  likes** exists and defaults to a modest 100.
