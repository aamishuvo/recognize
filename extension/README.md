# Recognize Auto Liker — Chrome Extension

Automatically likes RecognizeApp recognitions that **you have not liked yet**, scrolling
the feed as it goes. It never removes a like you already gave.

Pure Manifest V3 extension. No Node, no npm, no build step, no server, no external
executable, no API key. Download the folder, load it unpacked, done.

---

## 1. What it does

1. You log into RecognizeApp yourself, as normal.
2. You open the feed and press **START** in the extension popup.
3. It finds approval controls that are **unapproved + `data-method="post"`**, clicks them
   one at a time with human-like pauses, and verifies each one actually flipped to
   **approved + `data-method="delete"`**.
4. It scrolls the feed, waits for new posts, and repeats.
5. It stops when the maximum is reached, the feed is exhausted, or you stop it.

### What it deliberately does not do

| Not implemented | Why |
| --- | --- |
| Login automation | You log in yourself, manually |
| Password / credential handling or storage | Never touched |
| Cookie or session-token access | Never read, never exported |
| Authentication bypass or SSO interference | Never attempted |
| Direct calls to Recognize's API endpoints | It clicks the page's own anchors and lets the site do its normal thing |
| Any network request of its own | There is no `fetch`, no `XMLHttpRequest`, no backend — enforced by an automated check |
| Toggling a like off | See §4. This is the whole point. |

---

## 2. Installation (Windows, no admin rights needed)

1. Download / unzip this project somewhere you can find it, e.g. `C:\Users\you\recognize`.
2. Open **`chrome://extensions`**.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the **`extension`** folder (the one containing `manifest.json`) — not the
   project root.
6. Open RecognizeApp and **log in normally**.
7. Open your recognition feed.
8. Click the extension icon in the toolbar.
9. Press **START**.

Nothing is installed outside Chrome. No Windows settings, Chrome policies or security
controls are modified.

> **If your organisation blocks this:** some corporate Chrome policies disable Developer
> mode or unpacked extensions (`ExtensionInstallBlocklist`, `DeveloperToolsAvailability`,
> and similar). This extension cannot and does not try to override that — there is no
> workaround it could legitimately offer. Ask IT, or use the standalone console fallback
> in the project root (`dist/console-snippet.js`), which is the same engine pasted into
> DevTools.

### Updating

Replace the folder contents, then open `chrome://extensions` and press the **reload**
(↻) icon on the extension's card. Your settings and history survive.

---

## 3. Using it

### Popup

| Control | What it does |
| --- | --- |
| **START** | Begins scanning, liking and scrolling |
| **PAUSE** | Stops starting new clicks; the in-flight click finishes and is verified. **RESUME** continues |
| **STOP** | Immediate. No further click is dispatched |
| **Run diagnostic** | Reports what it can see and **clicks nothing** |

Statistics: **Scanned** (distinct recognitions seen), **Already liked** (yours before we
arrived), **New likes** (verified), **Skipped**, **Errors**, and the recognition ID
currently being worked on.

### Emergency stop

Press **`Esc`** on the Recognize tab. A capture-phase listener stops the run immediately,
whatever is focused. The on-page badge also carries a **STOP** button.

STOP is checked before **every** click and cancels every pending timer, so it takes
effect at once rather than at the end of the current delay.

### Diagnostic mode first

Before a real run, press **Run diagnostic**. It reports how many unliked and already-liked
recognitions it can see, the scroll container it found, example hrefs and recognition IDs —
without clicking anything. Full detail goes to the page console (`F12`).

**If it reports 0 unliked while you can see unliked posts, stop.** The selector needs
adjusting for your tenant, and a real run would do nothing anyway.

### Settings

In the popup (Scroll amount, Scroll delay, Click delay, Maximum new likes, Stop after no
new posts) or in **Options** for the full set.

| Setting | Default | Meaning |
| --- | --- | --- |
| Scroll amount | 700 px | Per scroll step. 0 = use 60–75% of the feed's height instead |
| Scroll delay | 1500 ms | Randomised 0.8×–1.67× → **1200–2500 ms** |
| Click delay | 1200 ms | Randomised 0.667×–1.5× before a click → **800–1800 ms**, and 0.667×–1.667× after → **800–2000 ms** |
| Minimum / maximum click delay | blank | Explicit override. Blank = derived from Click delay as above |
| Maximum new likes per run | 100 | The run ends once this many are verified |
| Stop after no new posts | 5 | Consecutive scrolls loading nothing before the run ends |
| Verification timeout | 3000 ms | Budget to confirm the approved+delete transition |
| Give up after repeated failures | 3 | Skip an item that failed verification this often before. Can only ever *reduce* clicking |

---

## 4. How "already liked" is decided — the safety model

**This is a "like if not already liked" tool. It is not a "toggle like" tool.**

Clicking an already-approved control sends the `DELETE` and **removes your own existing
like**. That is the one failure mode here that destroys data rather than merely doing
nothing, so it is prevented structurally.

### The two states

| | Class | `data-method` | href | Action |
| --- | --- | --- | --- | --- |
| Not liked by you | `approval_link unapproved` | `post` | `/recognitions/<id>/approvals` | **CLICK** |
| Liked by you | `approval_link approved` | `delete` | `/recognitions/<id>/approvals/<approval_id>` | **NOTHING** |

### The "+N" number is not a state signal

The number inside the control (`+1`, `+4`, `+5`) is the **total approvals from all
users**. It says nothing about whether *you* liked the post: an unliked recognition can
read `+4`, and after you like it, `+5`. Two recognitions can both show `+4` while one
needs a click and the other must never be touched.

The extension therefore **never reads the control's text** for any decision. `data-sender`
is not a signal either — the real DOM populates it in both states.

### The hard gate

A click is dispatched only for an element that satisfies, on a **fresh DOM query taken
immediately before the click**, every one of:

```js
el.isConnected                                 // still attached to the document
el.tagName === 'A'
el.classList.contains('approval_link')
!el.classList.contains('approved')             // <-- refused first
el.getAttribute('data-method') !== 'delete'    // <-- refused first
el.classList.contains('unapproved')
el.getAttribute('data-category') === 'recognition'
el.getAttribute('data-event')    === 'liked'
el.getAttribute('data-method')   === 'post'
el.matches(SELECTORS.UNLIKED)                  // the composed selector must agree
/\/recognitions\/([A-Za-z0-9_-]+)\/approvals/  // href yields a recognition id
// plus: inside a recognition container, visible, and enabled
```

If **any** condition fails, or the element cannot be freshly re-verified, it is not
clicked.

The gate runs **three times** per click: at scan time, again after the pre-click delay
(the feed can change in between), and a third time inside `performClick()` with **zero
gap** before `el.click()` — so no `await`, timer, retry or future refactor can slip work
between the check and the click. `performClick()` throws rather than clicking anything it
cannot fully verify, and it contains the only `.click()` call in the engine. An automated
check in `tests/run-tests.cjs` fails the build if a second one ever appears.

### Post-click verification

After each click the engine re-queries **that recognition by ID** and requires the exact
transition `unapproved + post` → `approved + delete`. Half-changed counts as *not yet*,
never as *click again*. If it has not transitioned within the verification timeout it
gets **exactly one** controlled retry, then it is recorded as an error and the run moves
on. There is no code path that clicks a recognition a third time.

### Idempotency across days

Safe to run on the same feed every day. Recognitions you liked previously are seen as
`approved` / `delete` and skipped. The test suite proves this explicitly (Day 1 likes
A and B; Day 2 sees A and B approved plus a new C, and must click only C while leaving
A's and B's approval IDs byte-identical).

---

## 5. Duplicate protection and history

* Recognition IDs are parsed from the `href` and kept in a `Set` for the page session, so
  a card that reappears after scrolling is not processed twice.
* `chrome.storage.local` keeps a longer-lived history of processed IDs across reloads and
  browser restarts.

**History is bookkeeping and optimisation only. It never decides whether a recognition is
liked, and it can never cause a click.** The only thing it is allowed to do is make the
engine *skip* — specifically, give up on an item that has failed verification repeatedly.
The live DOM is re-read before every single click regardless of what history says:

| History says | DOM says | Result |
| --- | --- | --- |
| liked | `unapproved` + `post` | **Liked** — the DOM wins |
| not liked | `approved` + `delete` | **Skipped** — the DOM wins |
| unknown | `unapproved` + `post` | **Liked** |

Clearing history is always safe (**Options → Clear history**); at worst the extension
re-examines items it has seen before.

---

## 6. Auto-scroll and the dynamic feed

The extension does **not** assume the page scrolls. It walks up from a real recognition
card to find the nearest ancestor that is genuinely scrollable (`overflow-y: auto|scroll`
and `scrollHeight > clientHeight`), and only falls back to the document scroller if there
is none. A container that was not yet scrollable is re-probed as the feed grows.

After each scroll it waits for new content using a `MutationObserver` plus a single
timeout — it resolves as soon as cards are inserted, and there is no tight polling loop.
End of feed is declared after N consecutive scrolls that produce no new cards, no height
growth and no pending unliked items.

---

## 7. Running minimised or in the background

The extension is built so it does **not** need to be watched:

* Automation is plain DOM work in a content script — no `requestAnimationFrame`, no
  screen coordinates, no mouse or keyboard simulation, no screenshots, no image
  recognition, no DevTools.
* It **never** checks `document.hidden` or `visibilityState`, and never stops because the
  tab is in the background. An automated check fails the build if those appear in the
  engine, and a test runs a full pass with `document.hidden` forced to `true`.
* Each wait is **one** timer for its full duration, never a chain of short timers —
  chained short timeouts are throttled hard in background tabs, which would turn a 1.5 s
  wait into many minutes.
* Nothing important lives in the service worker: MV3 suspends it freely, so all state is
  in `chrome.storage.local` and all automation is in the content script.

### Important limitation — please read

**Guaranteed background execution is not something a Chrome extension can offer, and this
one does not claim it.**

* Chrome throttles timers in hidden/background tabs (roughly one wake per minute after a
  few minutes). The run continues, but **slowly**. The popup reports this honestly as
  `RUNNING (throttled)` rather than pretending otherwise.
* If Windows sleeps or hibernates, Chrome is closed or killed, the tab is discarded under
  memory pressure, or the machine locks in a way your policy configures to suspend
  Chrome, the automation stops. It resumes when execution resumes only if the page is
  still loaded; a discarded or reloaded tab starts from scratch.
* Corporate policy can suspend or restrict background activity in ways nothing here can
  or should defeat.

No attempt is made to bypass Chrome's throttling or any browser security mechanism.
**For a fast, dependable run, leave the Recognize tab visible.** Minimised works, subject
to the above.

---

## 8. Permissions — every one explained

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves your settings and the processed-ID history in `chrome.storage.local`, on your machine. Nothing is sent anywhere |
| `alarms` | A twice-a-minute watchdog that persists the latest status and notices when a background run has stalled, so the popup can report the truth after the MV3 service worker has been suspended |
| `host_permissions: https://recognizeapp.com/*`, `https://*.recognizeapp.com/*` | Lets the content script run on your Recognize feed, and lets the popup talk to that tab |

Not requested: **`<all_urls>`**, `tabs`, `cookies`, `webRequest`, `scripting`, `downloads`,
`history`, `identity`. The extension is inert on every site except RecognizeApp.

---

## 9. Privacy

* No data leaves your browser. There is no backend, no analytics, no telemetry, and no
  network request of any kind — enforced by an automated check that fails the build if
  `fetch`, `XMLHttpRequest`, `document.cookie`, `chrome.cookies` or `navigator.credentials`
  appears anywhere in `extension/`.
* Stored locally, and only locally: your settings, and a list of recognition IDs already
  processed (short opaque strings such as `rglauokd`).
* Never accessed: passwords, cookies, session or SSO tokens, the browser password
  manager, browsing history, or any page other than RecognizeApp.
* Debug logging prints recognition IDs and counts only — never account data.

---

## 10. Troubleshooting

**The popup says "Open your RecognizeApp feed tab"**
The active tab is not on `recognizeapp.com`. Switch to the feed tab and reopen the popup.
If your tenant uses a different domain, add it to `host_permissions` and `matches` in
`manifest.json`, then reload the extension.

**"Could not reach the page. Reload the Recognize tab"**
The content script is not in that tab — usually because the tab was open *before* the
extension was loaded. Reload the Recognize tab.

**Diagnostic reports 0 unliked, but you can see unliked posts**
Right-click a `+` control → **Inspect** and compare the classes and `data-` attributes
against §4. If your tenant renders something different, update `SELECTORS.UNLIKED` in
`content/engine.js` and reload the extension.

**It likes a few, then stops with END_OF_FEED too early**
Your feed's lazy loading is slower than the wait. Raise **Scroll delay** (e.g. 2500) and
**Stop after no new posts** (e.g. 8).

**Everything comes back as an error**
Clicks are firing but the server is not approving. Open the Network tab and look for
failing `POST .../approvals` requests — that is a server or permission issue, not an
automation one. Stop and check whether your account can like those posts at all.

**It is very slow while minimised**
That is Chrome's background throttling. See §7. Bring the tab forward.

**Counts reset after a reload**
Expected: per-run statistics are per page session. Liked state is always re-read from the
DOM, so nothing is lost or double-liked.

**Nothing happens when I press START and the console shows a Rails UJS error**
The site's own JavaScript had not finished booting. Let the feed render fully, then press
START.

---

## 11. Files

```
extension/
├── manifest.json          MV3 manifest — permissions, matches, entry points
├── background.js          Service worker: defaults, status cache, stall watchdog
├── content/
│   ├── engine.js          The automation engine. No chrome.* — pure DOM. The safety gate lives here
│   ├── content.js         Chrome glue: messaging, storage, history, Esc, on-page badge
│   └── overlay.css        Positioning for the on-page STOP badge
├── popup.html/.css/.js    Dashboard: status, statistics, START/PAUSE/STOP, quick settings
├── options.html/.css/.js  Full settings, clear history, restore defaults
├── icons/                 16 / 32 / 48 / 128 px
└── README.md              This file
```

`engine.js` contains no `chrome.*` calls on purpose: the same file is what the project's
tests exercise and what the standalone fallback builds use, so there is exactly **one**
implementation of the click-safety gate.

---

## 12. Verifying it yourself

Open **`tests/mock/test-runner.html`** (in the project root, not in `extension/`) in
Chrome. It runs the real engine against a mock feed — 20 tests including the Day 1 / Day 2
idempotency test — and needs no Node, no npm and no server. The mock deliberately models
the destructive delete: if a regression ever clicked an approved control there, the like
really would be removed and the tests name which ones.
