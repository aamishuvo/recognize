# Recognize Auto Liker — iPhone / iOS Safari

Run the auto-liker from an iPhone, in Safari, with **no app and no extension**.

This is an **additive** feature. The Chrome extension, the console snippet, the
userscript, the bookmarklet and all their build scripts are untouched and keep
working exactly as before.

---

## How it works

Safari's Shortcuts action **Run JavaScript on Web Page** executes a script
against the page you currently have open. The script injects a small panel at
the bottom of the RecognizeApp feed with START / PAUSE / STOP and live counters.

It is the **same engine** the Chrome extension runs
(`extension/content/engine.js`), so iPhone and desktop enforce byte-identical
click-safety rules. Nothing about which elements may be clicked is
re-implemented for iOS.

```
extension/content/engine.js  ─┬─→ Chrome extension       (extension/)
                              ├─→ console / bookmarklet  (dist/)
                              ├─→ Tampermonkey           (userscript/)
                              └─→ iPhone Safari          (iphone-safari/)  ← new
```

---

## Files

| File | What it is |
| --- | --- |
| `generator.html` | Open in any browser (phone or desktop): set options, **Copy JavaScript**, **Download .js**, and read the Shortcut instructions |
| `recognize-auto-liker.ios.js` | The generated, self-contained script to paste into the Shortcut |
| `src/ios-panel.js` | The iOS host — mobile panel, `completion()` handling. Source, not for pasting |
| `shortcut-guide.md` | Beginner step-by-step for building the Shortcut |
| `tests/mock-recognize.html` | 18-test suite. Open it in any browser — including the iPhone — and it runs |

Regenerate after changing the engine or the host:

```bash
node tools/build-ios.cjs      # or: npm run build:ios
```

This writes **only** into `iphone-safari/`. It does not touch `tools/build.cjs`
or anything that script produces.

---

## Quick start

1. Open `generator.html`, tap **Copy JavaScript**.
2. Shortcuts app → **+** → add **Run JavaScript on Web Page** → paste → turn on
   **Show in Share Sheet** → name it → **Done**.
3. Safari → RecognizeApp → **log in normally** → open the feed.
4. **Share** → tap your shortcut → **Allow**.
5. Tap **START** in the panel that appears.

Full detail, with the fiddly iOS bits: [`shortcut-guide.md`](shortcut-guide.md).

---

## Safety — it can never remove a like

**This is a "like if not already liked" tool. It is never a "toggle like" tool.**
Clicking an already-approved control sends the `DELETE` and would remove your own
like — the one mistake that destroys data instead of doing nothing.

| | Class | `data-method` | Action |
| --- | --- | --- | --- |
| Not liked by you | `approval_link unapproved` | `post` | **CLICK** |
| Liked by you | `approval_link approved` | `delete` | **NOTHING** |

### The "+N" number is never used

`+1`, `+4`, `+5` is the **total from all users**. An unliked recognition can show
`+4`; after you like it, `+5`. Two recognitions can both show `+4` while one needs
a click and the other must never be touched. The script never reads the control's
text for any decision, and `data-sender` is populated in both states so it is not
a signal either.

### `isSafeToLike()` — checked immediately before every click

```js
el.isConnected                                 // still attached to the document
el.tagName === 'A'
el.classList.contains('approval_link')
!el.classList.contains('approved')             // refused first
el.getAttribute('data-method') !== 'delete'    // refused first
el.classList.contains('unapproved')
el.getAttribute('data-category') === 'recognition'
el.getAttribute('data-event')    === 'liked'
el.getAttribute('data-method')   === 'post'
el.matches(SELECTORS.UNLIKED)                  // the composed selector must agree
/\/recognitions\/([A-Za-z0-9_-]+)\/approvals/  // href yields a recognition id
// plus: inside a recognition container, visible, and enabled
```

The gate runs **three times** per click — at scan, again after the pre-click
delay, and once more inside `performClick()` with **zero gap** before
`el.click()`. That function throws rather than clicking anything it cannot fully
verify, and it holds the only `.click()` in the entire script (asserted by a
test). No element reference is held across a delay: the recognition is always
re-found by ID and re-checked.

### After the click

The script re-finds that recognition and requires the exact transition
`unapproved + post` → `approved + delete`. Half-changed counts as *not yet*,
never as *click again*. If it has not transitioned within the verification
timeout it gets **exactly one** controlled retry, then it is recorded as an error
and the run moves on. There is no path that clicks a recognition a third time.

### Duplicate protection

Recognition IDs are parsed from the `href` and remembered for the current run, so
a card that reappears after scrolling is not processed twice. **That memory can
only cause a skip, never a click** — the DOM is re-read before every click and
always wins. Nothing is persisted between runs (there is no storage of any kind
on iOS).

---

## Auto-scroll

The script does not assume the page scrolls. It walks up from a real recognition
card to find the nearest genuinely scrollable ancestor (`overflow-y: auto|scroll`
with `scrollHeight > clientHeight`), falling back to `document.scrollingElement`
if there is none. A container that was not yet scrollable is re-probed as the
feed grows.

Each cycle: process every safe unliked control in view → scroll → wait for new
content → scan again. New posts are noticed by a `MutationObserver`, and the loop
also rescans the DOM every cycle, so it does not depend on the observer alone.
Waits are single `setTimeout` calls, never tight polling.

The run ends when the maximum is reached, the feed produces no new content for N
consecutive scrolls, you press STOP, or Safari stops the page.

### Timings (configurable)

| | Range |
| --- | --- |
| Before a click | 800–1800 ms |
| After a click | 1000–2500 ms |
| After a scroll | 1200–2500 ms |

Adjustable in `generator.html` before you copy, and in the on-page panel while it
runs.

---

## iOS Safari limitations — read this

**This cannot run in the background, and this feature does not claim it can.**

* **iOS suspends web pages that are not on screen.** Switch apps, lock the phone,
  or move to another tab and the run pauses. It resumes when you come back to the
  tab — as long as Safari kept the page alive.
* **Safari may discard the page entirely** under memory pressure, or reload it
  when you return. Then the script is gone and you run the Shortcut again. Nothing
  is lost: liked state is read from the page, so it simply picks up where the DOM
  says it should.
* **Shortcuts has its own time limit** for the Run-JavaScript action. That is why
  the script calls `completion()` as soon as the panel is up: the Shortcut
  finishes immediately, and the automation then lives in the page, driven by the
  panel — not by the Shortcut.
* **A Low Power Mode or a locked screen** will pause things sooner.
* No attempt is made to defeat any of this. There is no legitimate way to, and
  trying would be working around a deliberate platform behaviour.

**In practice: keep the Safari tab open and on screen, and set a modest maximum
so a run finishes in a couple of minutes.**

---

## Privacy

* Nothing is transmitted anywhere. No `fetch`, no `XMLHttpRequest`, no
  `sendBeacon`, no external script or stylesheet — verified both by a source scan
  and by a test that spies on those APIs during a real run and asserts zero calls.
* No storage of any kind: no `localStorage`, `sessionStorage`, `indexedDB` or
  cookies. Close the tab and nothing remains.
* No credentials, passwords, session or SSO tokens are read. You log in yourself.
* No private Recognize API is called. The script clicks the page's own anchor and
  lets the site perform its normal action.
* No `chrome.*` API is used, so the file is genuinely self-contained.

---

## Testing

Open **`tests/mock-recognize.html`** in any browser — desktop or the iPhone
itself. It loads the **generated** script and runs 18 tests against a mock feed.
No Node, no npm, no server.

| # | Test |
| --- | --- |
| 1–2 | Unliked `+0` and unliked `+4` are clicked |
| 3–4 | Already liked `+1` and `+5` are not clicked |
| 5 | A previously liked recognition met again is never toggled off |
| 6 | The DOM flipping to approved mid-delay prevents the click |
| 7 | A recognition loaded after scrolling is detected and liked |
| 8 | The same recognition appearing twice is clicked once |
| 9–10 | PAUSE / RESUME and STOP |
| 11 | Maximum new likes stops the run |
| 12 | No new content ends the run gracefully |
| 13 | An approved / delete control can never be clicked |
| 14 | An unapproved / post control is allowed, and its ID is parsed |
| **15** | **Day 1 / Day 2 idempotency — A and B are never unliked** |
| 16 | The generated script mounts a mobile panel (44px targets, fits 390px) and calls `completion()` once |
| 17 | The generated script uses the documented iPhone timings |
| 18 | A real run makes no network call and writes no browser storage |

The mock **models the destructive delete faithfully** — clicking an approved
control there really removes the like and decrements the count — so a regression
causes observable damage and the tests name exactly which likes were destroyed.

Headless (optional, developer-only): `node tests/run-tests.cjs` from the project
root runs this suite at a 390×844 touch viewport alongside everything else.

---

## Troubleshooting

**Panel says 0 not-yet-liked but you can see unliked posts**
Your tenant may render the control differently. On a desktop browser, inspect a
`+` control and compare against the table above. If it differs, edit
`SELECTORS.UNLIKED` in `extension/content/engine.js`, run `node tools/build-ios.cjs`,
and copy the script again.

**It scrolls but never loads more posts**
Raise **Scroll delay** to 2500 in the panel. Your connection may be slower than
the wait.

**Everything comes back as an error**
Clicks are firing but the server is not approving. That is a server or permission
issue, not an automation one — stop and check whether you can like those posts by
hand.

**It runs, then just stops**
Almost always iOS suspending or reloading the page. Run the Shortcut again and
press START; already-liked posts are skipped, so nothing is duplicated.
