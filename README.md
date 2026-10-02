# NOVI

**A voice-first personal AI companion that orchestrates your AI tools, apps and devices.**

Novi is not another chatbot. It is an AI layer that sits *above* other AI tools, applications and devices — you talk to one companion, and it decides what needs to happen, which model or tool should handle it, whether it needs your permission, and how to report back.

```
Instead of:  You → ChatGPT / Claude / Gemini / your computer
It becomes:  You → Novi → everything else
```

---

## The core idea

Today, getting something done across your digital life means opening a different app or AI tool for every task. Novi replaces that with a single conversational interface.

You say what you want. Novi works out:

- what needs to be done
- which AI or model should handle it
- which tools or applications are required
- whether it needs your permission first
- how to execute it
- how to report the result back to you

---

## What it looks like in practice

### Supervising a coding agent from another room

You're sitting by the TV. Your laptop is somewhere else, with your project on it and Claude Code installed.

> **"Hey Novi, open my project and start working on it with Claude."**

Novi understands the command, identifies the project, connects securely to your laptop, opens Claude Code, and hands over the instruction. Claude works on the real files, on your real machine.

Then you stay in the loop, by voice:

> **"Ask Claude to implement the login system."**
>
> **"What's the progress?"**
> → *"Three files changed in the auth module. Tests are running."*
>
> **"Ask Claude to fix the errors and run the tests."**
>
> **"Stop the task."**

You never open a terminal. Your phone is the interface; your laptop does the work.

### Other everyday commands

```
"Continue working on my project."
"What changed since yesterday?"
"Explain what the AI just changed."
"Show me the project progress on my TV."
"Create a reminder for tomorrow."
"What should I work on next?"
```

The interaction should feel like a conversation, not a list of memorised commands.

---

## How it works

```
                        USER
                          |
                   Voice  /  Text
                          |
                  ┌───────────────┐
                  │     NOVI      │
                  └───────────────┘
                          |
                 Intent understanding
                          |
                    Task planner
                          |
                  Agent orchestrator
                          |
        ┌─────────────────┼─────────────────┐
        |                 |                 |
    AI Models          Tools            Devices
        |                 |                 |
     Claude            Browser             PC
      GPT              GitHub             Phone
     Gemini             Files              TV
     Local              APIs              ...
        |                 |                 |
        └─────────────────┼─────────────────┘
                          |
                   Task execution
                          |
                  Result  /  Status
                          |
                        USER
```

### Remote execution model

```
PHONE  →  Novi  →  secure connection  →  Novi desktop agent  →  local project  →  Claude Code
```

The work happens **on your machine**, against **your real files**. Novi is the remote conversational interface, not a cloud sandbox. This is a deliberate choice: local-first, with your code staying where it already lives.

---

## Principles

### Model-agnostic

One companion, many brains. Coding goes to a coding agent, research to a web agent, image analysis to a vision model, private work to a local model. You never switch platforms manually.

### Real-time awareness

Novi doesn't fire a request and disappear. It follows the state of a running task and narrates it — *"tests are running"*, *"an error was found"*, *"Claude is attempting to fix it"* — and you can interrupt, redirect or stop it mid-flight.

### Persistent memory

Novi should remember your projects and where they live, ongoing tasks, frequently used tools, preferences and past decisions. So `"continue my project"` works without you spelling out a file path every time.

Memory is under your control: viewable, deletable, privately stored, with clear permission boundaries.

### Extensible by plugin

Adding a capability should mean adding a tool, not rewriting the application. MCP (Model Context Protocol) is the intended foundation for the tool layer.

### You stay in control

Novi never blindly executes. Actions are tiered:

| Tier | Examples | Behaviour |
|------|----------|-----------|
| **Low risk** | search, read files, summarise, research | may run automatically |
| **Medium risk** | modify files, install software, commit, send messages | asks for confirmation |
| **High risk** | delete data, financial actions, security or account changes | always requires explicit approval |

---

## Roadmap

**MVP**

- [x] Voice input (push-to-talk, Groq Whisper, browser speech fallback)
- [x] Conversational AI with tool calling
- [x] Basic memory (projects and tasks)
- [x] Small plugin/tool system
- [x] Basic computer interaction (the coding agent's file and shell tools, confined to a project)
- [x] Task execution with live status updates

**Then**

- [x] Multi-AI orchestration across free providers (Groq ⇄ Gemini with automatic fallback)
- [x] Phone → laptop control on home Wi-Fi (pairing code)
- [x] Coding-agent supervision by voice (Novi Coder; Claude Code adapter ready, off by default)
- [ ] Remote phone → laptop control from anywhere
- [ ] Persistent memory (preferences, decisions, conversations)
- [ ] Browser automation
- [ ] GitHub integration
- [ ] TV / casting output
- [ ] Multi-device support

The intended evolution: **voice assistant → AI agent → multi-AI orchestrator → personal AI operating layer.**

---

## Status

MVP working. Everything runs on free Groq and Gemini API keys, including the built-in coding agent, **Novi Coder**.

## Run it

Requirements: Node 24+ and free API keys from [Groq](https://console.groq.com) and [Google AI Studio](https://aistudio.google.com). No paid APIs are needed.

```bash
npm install
cp .env.example .env   # add GROQ_API_KEYS and GEMINI_API_KEYS
npm start              # builds the UI and starts https://localhost:3001
```

Open `https://localhost:3001` on the laptop and accept the certificate warning (Novi uses a self-signed certificate so phones allow the microphone). Then:

- **Tell Novi about a project:** "Remember my portfolio project at C:\path\to\portfolio"
- **Give it work:** "Ask the coder to add a contact page to my portfolio project"
- **Check in:** "What's the coder doing?" · **Follow up:** "Tell the coder to also add tests" · **Stop:** "stop"

Every file edit and command asks for your approval (Allow / Deny cards, also spoken). Risky commands such as `git push` or recursive deletes are marked high risk and can only be approved on screen.

**Phone:** on the same Wi-Fi, open Settings (gear icon) → *Pair a phone*, visit the URL shown on your phone, accept the certificate warning, and enter the 6-digit code.

**Development:** `npm run dev` (UI with hot reload on http://localhost:5173) · `npm test`.

**Later — Claude Code:** set `NOVI_CODER=claude` in `.env` to hand coding tasks to [Claude Code](https://claude.com/claude-code) instead of Novi Coder (requires the `claude` CLI logged in; uses your Claude plan).

## Design notes

Novi builds on an existing agent runtime rather than reimplementing the plumbing (chat transport, model routing, session handling), so effort goes into what makes it distinct: **voice-first supervision of running agents**, **narrated real-time progress**, **TV as an output surface**, and **permission tiers as a core design element rather than an afterthought**.

---

## License

Not yet specified.
