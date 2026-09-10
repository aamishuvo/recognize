# Creating the iPhone Shortcut — step by step

For someone who has never made a Shortcut before. It takes about five minutes,
once.

You are **not** installing an app. You are saving a piece of JavaScript into the
Shortcuts app so Safari can run it on the Recognize page you already have open.

> **Nothing here asks for your password.** You log into RecognizeApp yourself, in
> Safari, exactly as you normally do. The script never sees your credentials,
> cookies or tokens, and never sends anything anywhere.

---

## Part 1 — Get the JavaScript onto your phone

Pick whichever is easiest:

**A. Straight from the phone (simplest)**
1. Get `iphone-safari/generator.html` onto the iPhone — AirDrop it, email it to
   yourself, or drop it in iCloud Drive / Files.
2. Open it (tap it in Files; it opens in Safari).
3. Optionally adjust *Maximum new likes*, *Scroll amount*, *Scroll delay*,
   *Click delay*.
4. Tap **Copy JavaScript**. The whole script is now on your clipboard.

**B. From a computer**
1. Open `iphone-safari/generator.html` in any browser and tap **Copy JavaScript**.
2. Send it to yourself (Messages, Notes, email) and copy it on the phone.

**C. Just the file**
Use `iphone-safari/recognize-auto-liker.ios.js` directly — open it in any text
editor, select all, copy. (This uses the built-in default settings.)

---

## Part 2 — Build the Shortcut

1. Open the **Shortcuts** app.
2. Tap **+** (top right) to create a new shortcut.
3. Tap **Add Action** and search for **JavaScript**.
4. Choose **Run JavaScript on Web Page**.
   *Depending on your iOS version this may be listed under **Safari** or **Web**.
   If the exact name differs, pick the action that runs JavaScript against the
   current Safari page — that is the one.*
5. The action shows a box with placeholder text. Tap inside it, select the
   placeholder, and **Paste**.
   *It is a large script, so pasting takes a second or two. That is normal.*
6. Open the shortcut's **details** — the ⓘ button, or the settings/slider icon at
   the top, depending on iOS version.
7. Turn on **Show in Share Sheet**.
8. If you see a list of accepted input types, make sure **Safari web pages**
   (sometimes shown as *URLs*) is ticked. Untick the rest if you like — it keeps
   your share sheet tidy.
9. Give it a name, for example **Recognize Auto Liker**.
10. Tap **Done**.

---

## Part 3 — Run it

1. Open **Safari** and go to RecognizeApp.
2. **Log in normally.** (The script cannot and does not do this for you.)
3. Open your recognition feed and let it finish loading.
4. Tap the **Share** button (the square with the arrow).
5. Scroll down the share sheet and tap **Recognize Auto Liker**.
6. The first time, iOS asks permission for the shortcut to run on that page —
   tap **Allow**. If it offers **Always Allow** for this site, that saves you the
   prompt next time.
7. A panel slides up at the bottom of the page showing how many recognitions are
   not yet liked.
8. Tap **START**.

**To stop:** tap the big red **STOP** button. It takes effect immediately — no
further click is sent.

**To hide the panel:** tap the small ▾ arrow in its top-right corner. It
collapses to a single bar so you can read the feed; tap ▴ to bring it back.

---

## What you should see

```
Recognize Auto Liker              RUNNING
┌──────────┬──────────┬──────────┐
│    7     │    4     │    12    │
│NEW LIKES │ ALREADY  │ SCANNED  │
├──────────┼──────────┼──────────┤
│    0     │    0     │    3     │
│ SKIPPED  │  ERRORS  │ SCROLLS  │
└──────────┴──────────┴──────────┘
Current recognition       rglad2rn

[  START  ] [  PAUSE  ] [  STOP  ]
```

* **New likes** — recognitions this run liked, each one verified afterwards.
* **Already** — recognitions you had already liked. These are never touched.
* **Skipped** / **Errors** — see the log strip underneath for the reason.

---

## Advice for the first run

Set **Maximum new likes** to **3–5** and press START. Watch what happens, scroll
back up and check that the posts you had already liked are untouched. Then raise
the number.

---

## If something does not work

**The shortcut is not in the Share sheet**
Shortcuts → your shortcut → details → **Show in Share Sheet** must be on. If it
is on but still missing, scroll the share sheet right to the end and tap
**Edit Actions…** to pin it.

**"Safari cannot run this shortcut" / no permission prompt**
Shortcuts must be allowed to run scripts: Settings → Shortcuts → **Advanced** →
turn on **Allow Running Scripts**.

**The panel does not appear**
The page was probably still loading, or you were not on the feed. Let it finish,
then run the shortcut again.

**The panel says 0 recognitions not yet liked**
Either you really have liked everything visible, or your tenant renders the Like
control differently. Scroll down to load more posts and run it again; if it is
still 0 while you can plainly see unliked posts, the selector needs adjusting —
see the troubleshooting section of `README.md` in this folder.

**It stops when I switch apps**
That is iOS, and it is expected. See the limitations section in `README.md`.
Keep the tab on screen while it runs.

**Pasting the script seems stuck**
It is roughly 48 KB of text. Give it a few seconds. If the Shortcuts editor
struggles, use the **Download .js** button in the generator and paste from the
Files app instead.
