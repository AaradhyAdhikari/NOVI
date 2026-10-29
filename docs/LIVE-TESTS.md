# Novi — live tests to do

Everything here is built and passes its tests on the computer, but hasn't been tried by you for real yet
(or was tried and still has a known problem). Try them on the real Novi (https://localhost:3001) or on the
test copy (**Test Novi.cmd** → https://localhost:3002) when you don't want to disturb the real one.
Tick a box when it works; if it doesn't, tell Claude what you said and what Novi did.

Last updated: 2026-10-22.

## Already checked live (works)

- Natural voice (Edge voices, en / hi / mr) — fixed 2026-10-21.
- "browse X" / "open X.com" without the AI (~0.2 s).
- Weather, time/date, LeetCode today's problem, GitHub contribution graph, YouTube by voice.
- The brief: "let's build a tiny tip calculator app" → ChatGPT plan + Gemini examples/security → "yes" →
  Claude built the Tip calculator → "show me the homepage of tip calculator" sent a picture + live link.
- The brief now runs fully in the background (18 s, nothing on your screen).
- Tip calculator made on claude.ai; "sync my Claude projects" lists all 13 claude.ai projects.
- "check my ChatGPT plan" reads your NOVI chat.
- Novi's ChatGPT / Gemini / claude.ai work stays in one minimized Chrome window (no tab pile-up).
- No more freezes; "open my github profile" is instant; "where is my resume" ≈ 3.5 s.

## Only my voice (2026-10-29, built, not tried live yet)
Setup once: the speaker model is **not on the laptop yet**. Download `wespeaker_en_voxceleb_resnet34.onnx` (≈26 MB) from
https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx
into `C:\dev\NOVI\models\speaker\`, restart Novi, then Settings → "Hey Novi" → **Learn my voice** (your 61 practice clips are already there).
- [ ] Settings → "Hey Novi" shows "Only my voice can command Novi" ticked after learning.
- [ ] Your own voice on the laptop mic, the talk button and the phone app works as before.
- [ ] Someone else (or a video) says "what time is it" into the talk button / phone app → "That didn't sound like you." (said once a minute at most), nothing happens; Settings → Activity shows "not your voice".
- [ ] A card waits for your PIN: the PIN still works by voice (the PIN is the proof); typed messages are never checked.
- [ ] Novi ignores you? Lower Strictness a little in Settings. Untick the box to turn the check off.
- [ ] The log shows `[timing] voice check N ms` — tell Claude the number (should be well under 300 ms).

## claude.ai project instructions (2026-10-29, built, not tried live yet)
Before, Novi never clicked the right button: the plain "Add" next to Instructions is the Context file uploader. Now it clicks the real Instructions button, and only fills the box if it's empty (your own text is never changed).
- [ ] Build something new ("let's build a tiny unit converter app" → "yes"), then open that project on claude.ai: Instructions should name the folder (`C:\dev\…`) and the brief.
- [ ] Linked projects with a folder and empty instructions get filled in on their own about 30 s after Novi starts (Chrome connected), once each. Portfolio and Tip calculator already had instructions when Claude checked on 2026-10-28, so they're left alone. To see it work, clear one project's instructions on claude.ai, delete its line under `instructed` in `data/claude-link.json`, and restart Novi.

## Changes, tests and "what is Claude working on" (2026-10-29)
- [x] "What is Claude working on?" now sees any Claude Code session on the laptop (the Claude app too): live → "Claude Code is working on novi. Right now it is running a command: …". It was "isn't working on any task".
- [x] "What changed in Novi" → the changed files with +/− lines (live, 12 files).
- [x] "Show me my Claude usage" / "Claude stats" / "how much Claude is left" → read from claude.ai in the hidden Chrome tab and said (live: "this session 47% used, resets at 6:20 AM. This week 59% used…").
- [ ] "show me the changes in App.jsx" → the changed lines.
- [ ] "run the tests" / "did the tests pass" on a project with tests → "N passed, M failed: …".
- [ ] When Claude finishes a task → "Claude changed N files: …".

## Done-check: Novi checks Claude's work against the brief (2026-10-28)
- [x] Live on the Tip calculator (checklist made from its brief note): "check my tip calculator app" → 128 s → 4 of 6 passed (both "type and click" checks really ran in a hidden browser), 2 "not sure" with honest reasons (keyboard focus can't be judged from a picture). Nothing outside the project's own site can be reached from the test page.
- [ ] A new brief → "yes" → when Claude finishes, Novi checks by itself and says "N of M checks passed…".
- [ ] "fix it" → Claude gets only the failed / unsure checks → Novi checks again ("round 2").
- [ ] "is it done" / "check it" (current project), "run the checks on X".
- Results: `<project>/.novi/check-results.jsonl`, pictures `.novi/check-shots/`, research log `data/donecheck/runs.jsonl`; the brief note gets "Checked <date>".

## Known problem: voice answers on the phone (2026-10-28, to fix later)
- Pop-up (app closed): 1.4.0 call mode heard nothing; 2.0.1 falls back to listening after the read-out — not tried yet.
- Inside the app (page open): the page listened but only caught "Nih." for the answer (voice log), so you had to tap.
- Lock screen answer by voice worked (1.3.x: "One." → option 1).
- In the app (2.0.x), the talk button says "Microphone unavailable…": the page's mic doesn't start inside the app's WebView. Fixed in app 2.1.0 (not tried yet): inside the app the talk button records with the app's own mic (`window.NoviApp` → `Recorder` → WAV back to the page → `/api/stt` as usual); also used when a card waits for a spoken answer in the app.

## Brief card "change X" (2026-10-28, live)
- [x] "let's build a tiny unit converter app" → card in 24 s → "change it to also convert currencies" → new card in 10 s with "Your changes: also convert currencies" → "no" → "Okay, I won't send the brief."

## Laptop voice (2026-10-28)
- [x] Female Edge voice back (msedge-tts 2.1.1 — Microsoft changed its service; the laptop had fallen back to the male Windows voice).
- [x] Two Novi pages open on the laptop no longer read every line twice: only the page used last speaks.

## Answer any card by voice (2026-10-28, checked by Claude on the test copy)

- [x] "approve" with nothing waiting → "There's nothing waiting for approval right now." (a plain "yes" still goes on as usual).
- [x] A card that can't take a note ("Start the tip calculator site?") + "yes but quickly" → "That one can't take a note. Say yes or no."
- [x] "actually what's the time" on that card → it says no to the card, then tells the time.
- [ ] Claude asks a question → "option 2" / "the second one" / "doosra" / the option's name; "dark" when two options say dark → "Did you mean option 2 … or option 3 …?"
- [ ] A Claude permission card → "approve but don't touch the tests" (Claude gets the note), "change it to X" (Claude does X instead).
- [ ] A card with choices (Novi Coder or Claude) → "option 2". Novi now reads the options out by number.
- [ ] A high-risk card at the laptop (e.g. Claude wants to git push) → Novi says "Say your PIN to approve, or say no" → say your PIN → approved. The chat shows "•••• (your PIN)", never the digits.
- [ ] On the phone, cards now sit at the top of the screen; after an answer a short status shows ("Approved", "Change sent", "Option sent").

### Cards pop up everywhere (2026-10-28)
- [x] Laptop: a card → Windows notification (Novi extension 1.10.0) with Approve / Deny → tapping Approve answered it (live, "Start the tip calculator site?").
- [ ] Phone, Novi closed: a card → phone notification with the short task + Approve / Deny (Claude's questions: the first two options). Tap Approve → answered without opening Novi.
- [ ] Phone, a PIN / high-risk / delete card → "Approve (PIN)" opens Novi on the card for the PIN; Deny works from the notification.
- [ ] Tapping the notification itself opens Novi. Answering on one device clears the laptop popup.
- If the phone shows nothing: open Novi on the phone → Settings → turn notifications on again (it re-subscribes; needs Novi opened through its https Tailscale address). It now sends a **test popup** right away; no popup → allow notifications for Chrome / the Novi site in the phone's settings.
- [x] Live 2026-10-28: "tell Claude to add dark mode to the tip calculator" → plan card popped up on the laptop (not the phone) → approved → Claude built it. Fixes after: cards go out at high push priority, the test popup, and the spoken plan line is short ("Claude's plan for X is ready: N steps. Go ahead?").
- [ ] Phone preview pictures are now the whole page in real phone mode (390 px, sharp): "show me the homepage of tip calculator".

### Novi phone app: cards ON the screen, over any app (2026-10-28, app 1.1.1, works live on the S24+)
Install once: **restart Novi on the laptop first** (Settings → Restart, or Update and Start Novi.cmd). On the phone,
download `Novi.apk` → open it → allow "Install unknown apps" for the app you downloaded it with → Install. Open
**Novi** → Connect: type the laptop's Tailscale name (the `….ts.net` part of Novi's phone address) and tap Connect,
or Scan QR from Novi on the laptop (Settings → Phone). Then tap every "Allow" button: Show cards over other
apps, Notifications, Microphone, Keep running. On a Samsung also: Settings → Apps → Novi → Battery → Unrestricted.
Rebuild after a change: double-click `android\build-apk.cmd` (APK: `android\Novi.apk`).
- [x] Test card → card at the bottom over the home screen, vibrate + chime + read out → approved (live 2026-10-28).
- [x] No mic button: right after reading the card out, Novi listens by itself (video paused) → said "approve" → approved (live; heard "Novi, Tex, Car. Approve." — the last clear answer counts). Nothing said in 5 s → "Didn't hear an answer: tap a button."
- [ ] Same over full-screen YouTube (the video pauses while Novi speaks and listens, then plays again) and with the screen off (it wakes up).
- [ ] Answer on the laptop instead → the card on the phone says "Answered" and goes away.
- [x] **Lock-screen card (app 1.2.0, live 2026-10-28)**: allow "Cards on the lock screen" in the app (full-screen notifications) → lock the phone / screen off → a card: the screen lights up with a big Novi card over the lock screen, read out, listens → "approve" works without unlocking. A PIN card shows "Unlock to approve" (never approved from the lock screen); Deny works. "Later" leaves it waiting as the pop-up after unlocking.
- [x] **Claude's question in full (app 1.3.x, live 2026-10-28)**: every option with its description + Other + Skip/Submit, on the pop-up and the lock screen; on the lock screen "one" picked option 1 by voice. Test: POST /api/test-card {question:true}.
- [ ] Screen on: voice answer to a question (first try missed — likely spoken during the read-out; 1.3.1 waits 10 s and hears a quieter voice). Say "in other, I want …" → goes to Claude as your own answer. Typing: tap Other → type → Submit.
- [ ] **One Novi app (2.0.0)**: the app opens the full Novi page (chat, talk, settings, memory), signed in by itself; ⚙ bottom-left = setup. While it's open the page shows the cards (no pop-up on top); leave the app → waiting cards pop up. Then uninstall the purple web app.
- [ ] Answer while Novi is still reading (1.4.0, call-mode echo cancelling): Novi stops and takes it. "One Bhashini" (number + name) now counts (live miss fixed).
- [ ] A permission card → "yes, but X" / "change it to X" → Novi's answer is spoken on the phone. Words from a video never count (only clear answers to that card).
- [ ] A PIN card (e.g. Claude wants to git push) → "Approve (PIN)" → PIN pad (only if Settings allow typed PINs) or "🎤 Say PIN" → approved; a wrong PIN says "PIN not accepted".
- [ ] "Later" shrinks the card to a small "Novi · 1 card" pill; tap it to open again.
- [ ] Phone restarted → the "Novi is connected" notification comes back by itself. Laptop off/on → it reconnects.
- Known: the web app's shade notifications still come too; turn them off in the web app's Settings if they're double.

## Code map with graphify (2026-10-24, checked by Claude on the test copy)

Needs graphify installed once (`pip install graphifyy` — already done on this laptop). No AI, no credits.
- [x] "map the Novi code" → "Mapping Novi's code…", then ~40 s later "Mapped Novi: 2179 parts and 4170 links…".
- [x] "how does the orchestrator connect to the task manager in Novi" → the chain of calls/imports (0.1 s).
- [x] "explain the ApprovalQueue class in Novi", "where is the TaskManager class in Novi" → file, line, what it links to.
- [x] "what uses the vocabulary module in Novi" → vocabulary.js and the three files that import it.
- [ ] "show me the Novi code map" → the interactive graph opens in the browser (on the phone: a link).
- [ ] Map your tip calculator ("map my tip calculator project"): asks nothing (your words are the yes), adds graphify-out/ to its .gitignore.
- [ ] After Claude finishes a task on a mapped project, the map refreshes by itself (nothing is said).
- [ ] Watch whether Claude opens fewer files on Novi now (its prompt says: read graphify-out/GRAPH_REPORT.md first).

## New tonight (2026-10-22, checked by Claude on the test copy)

- [x] "what does my FLEXR / SignSync project do", "medikiosk kya karta hai" → from the README / GitHub.
- [x] "progress of my FLEXR project" → now uses its GitHub commits too, with the right "how long ago".
- [x] "note that my DBMS exam is on 5 November" → "Noted: "my DBMS exam is on 5 November"." (used to say "…on 5.").
- [x] "show me a screenshot of my screen" → just the picture (no extra "Done.").
- [x] "list what's on my screen" → straight to the numbered list (the page's links first, Brave's own buttons last; the little picture-in-picture video window is skipped).
- [x] "what's the link of this page" / "which website is open" → the address at once (no AI).
- [x] Brief card: "change the colours to …" → a new card that shows "Your changes: …"; "no" → one reply.
- [x] "what's the weather" with no city set → asks once; the city you name is remembered.
- [ ] **New:** "close this tab" / "tab band karo" → closes the tab in the browser in front; "reopen the tab" brings it back in the same window. *(close/reopen worked; one wrong-window reopen was fixed after — try it once)*
- [ ] "busy" should now be rare: Novi waits out short limits (up to 5 s) instead of "try again in 1 seconds".

## New since 2026-10-21 — please check first

- [ ] With any page open in Brave/Chrome (e.g. Kick): "play the first video on screen", "click Subscribe", "open the snaxgaming stream"
      → Novi lists what's on screen and clicks it (the first click asks; say "always allow" to stop the questions).
- [ ] "send this video to Isha" / "copy the link of the current website and send it to Rahul" → sent on WhatsApp from the laptop.
- [ ] "send this page to my phone" (ask from the phone) → the laptop page's link in the chat. *(checked 2026-10-22)*
- [ ] "copy this link" → the page's link on the laptop clipboard.

- [ ] "what does my TraceBites app do", "what is FLEXR about", "tell me about my SignSync project", "medikiosk kya karta hai"
      → answered from the project's README / your GitHub repo, never a Google search. *(TraceBites checked 2026-10-22)*
- [ ] While a YouTube video plays: "skip 10 minutes", "go back 30 seconds", "rewind 2 minutes", "jump to 5:30",
      "10 minute aage karo". Try it with a Spotify song too, and from the phone. *(YouTube in Chrome checked 2026-10-22)*

- [ ] Use Chrome normally for a day: Novi's work stays in its one **hidden** "Novi work" window — nothing in the taskbar, Alt+Tab or Chrome's previews, never your tabs or screen.
- [ ] Leave Novi running for a few hours: Settings → System → **Delay** stays small (no long freezes).
- [ ] "open my github profile", "open YouTube", "what's the weather" — each answers in a couple of seconds.
- [ ] Questions about your things: "where is my resume", "what does my tracebite app do".
- [ ] Build something new ("let's build a tiny unit converter app" → "yes"): it also shows up in your claude.ai Projects.

## Voice

- [ ] "Hey Novi" on your own voice (no training model now — keyword spotting). Does it wake every time? Does it wake by itself?
- [ ] Say "Hey Novi" while Novi is talking → she stops and listens.
- [ ] Conversation: after a reply, just keep talking (no "Hey Novi") for the next request.
- [ ] Quiet mode: "be quiet for 30 minutes" → nothing spoken, everything still on screen; "talk again".
- [ ] Spoken approvals: answer a card with "yes" / "no" / "haan" / "nahi" / "always allow".
- [ ] Hindi / Marathi / Hinglish: "kal ka weather batao", "YouTube pe arijit singh lagao".
- [ ] Dictation: click in Notepad, hold **Ctrl+Shift+Space**, speak, let go → your words are typed. Also "type: hello there".
- [ ] Desktop orb: shows listening / thinking / talking, drag it, tap it to talk, right-click → Hide.
- [ ] "Learn my voice" (Settings → "Hey Novi"), then check a friend's "Hey Novi" is ignored (see "Only my voice" above).

## Laptop control

- [ ] "volume 30", "mute", "brightness 50", "pause the music", "next song".
- [ ] "how much battery do I have", "how much free space on my C drive".
- [ ] "turn off Bluetooth" / "lock the laptop" / "close Notepad" → each asks first.
- [ ] "go to Chrome", "minimize this", "copy your answer".
- [ ] "what commands did you run today"; Settings → History.

## Files

- [ ] "open my DBMS notes", "open the C language folder on my laptop".
- [ ] "summarize my resume", "make a folder called test on my desktop", "rename it to test2".
- [ ] "delete the test2 folder on my desktop" → must ask for your **voice PIN** (set one in Settings first).
- [ ] "take all my PDFs about DBMS into a folder called DBMS" → then "undo the move".
- [ ] From the phone: "send me my resume" → a Download link.

## Browser, WhatsApp, LeetCode

- [ ] "message Isha on WhatsApp that I'll be late" → sent without asking; a name with two matches asks "Which…?".
- [ ] "send my Portfolio folder to Isha on WhatsApp".
- [ ] "open the GitHub login page" → Novi pauses for the password ("type it on the laptop and say done").
- [ ] "show me today's LeetCode problem on my laptop", "my LeetCode stats".

## Coding with Claude

- [ ] "ask Claude to add dark mode to tip calculator" → a **plan card** first; try "yes", "change …" and "no".
- [ ] While Claude works: "what's the progress", "what's next", "make the button blue".
- [ ] Claude asks you a question → answer by voice ("the first one").
- [ ] "show me the code of the header" → **Edit** → change a line → **Approve**.
- [ ] "show me the blog section" / "send me a screenshot of the work you're doing".
- [ ] "I'm back, I'll take over" → Claude Code opens in a terminal on the same session.
- [ ] "rename tip calculator to tip buddy".

## Claude & ChatGPT links, Novi Memory

- [ ] "progress of my FLEXR project", "open TraceBites on claude.ai".
- [ ] "Medikiosk and medikiiosk are the same" → one dot in Settings → Memory → Show my notes.
- [ ] "note that my DBMS exam is on 5 November", "check my notes about DBMS", "what did you do today".
- [ ] "what did you get wrong this week".

## Phone (needs Tailscale on laptop + phone, MagicDNS + HTTPS on)

- [ ] Pair the phone (QR / "Ask the laptop"), install Novi as an app (PWA).
- [ ] Ask from the phone: the reply, pictures and links come to the phone, not the laptop.
- [ ] A reminder or Claude finishing while Novi is closed on the phone → a notification.
- [ ] A risky approval from the phone asks for the voice PIN.

## Google (needs setup first)

Enable the Calendar, Tasks, Drive and Sheets APIs in Google Cloud Console, then reconnect Google in Settings.
- [ ] "what's on my calendar today", "add a task: submit DBMS assignment".
- [ ] Nightly backup to Drive (check Drive the next morning); the "Novi log" sheet fills in.

## Known problems (no need to report again)

- ChatGPT **pinned chats** aren't read yet: Chrome's ChatGPT sidebar is closed / the window too narrow.
- Phone "Hey Novi" says "Speech error: network" — needs the Android app (planned).
- WhatsApp may still bring its tab to the front once if typing didn't land.
- One old "NOVI" ChatGPT tab opened by an older Novi (before its tabs were marked) may still sit in its own window — close it once by hand.
- The first question about your files after a restart may be answered without them (the search is warming up).
- Some laptop-mic noise still gets through (about 2 in 9 stray sounds).
- On small jobs Claude makes no plan list, so "progress" says step 0 of 0.
- GitHub sign-in plugin needs `NOVI_PLUGIN_GITHUB_CLIENT_ID` in `.env` (public graph works without it).
- SambaNova needs a card (402); Sarvam speech is paid after its sign-up credit.
