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
- [ ] "Learn my voice" (Settings → "Hey Novi"), then check a friend's "Hey Novi" is ignored.

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
