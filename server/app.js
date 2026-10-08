import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Memory } from './memory.js';
import { ApprovalQueue } from './permissions.js';
import { PermissionGrants } from './grants.js';
import { createGeminiVision } from './brain/vision.js';
import { createGoogleApi } from './google/api.js';
import { createEdgeTts, DEFAULT_VOICES } from './voice/edgeTts.js';
import { Router } from './brain/router.js';
import { Agent } from './brain/agent.js';
import { TaskManager } from './claude/taskManager.js';
import { ClaudeSession } from './claude/session.js';
import { FreeCoderSession } from './coder/freeCoder.js';
import { createNoviTools } from './tools/noviTools.js';
import { addLaptopTools } from './laptop/laptopTools.js';
import { Pairing, isLocalAddress } from './auth.js';
import { createSpeechEngine } from './voice/speechEngine.js';
import { createGroqWhisperStt } from './voice/providers/groqWhisper.js';
import { createGeminiStt } from './voice/providers/geminiStt.js';
import { createSarvamStt } from './voice/providers/sarvamStt.js';
import { TEST_PHRASES, createSampleStore } from './voice/samples.js';
import { plainText, spokenText } from './narrator.js';
import { AccountRegistry } from './accounts/registry.js';
import { SecretStore, defaultCipher } from './accounts/secrets.js';
import { GoogleAuth } from './google/oauth.js';
import { GmailClient } from './google/gmail.js';
import { addAccountTools } from './tools/accountTools.js';
import { resolveAccount, askNote } from './accounts/resolve.js';
import { ToolRegistry } from './tools/registry.js';
import { PluginHost } from './plugins/host.js';
import { wrapRegistryAsPlugin } from './plugins/builtin.js';
import { openUrl } from './laptop/opener.js';
import { createRemoteTrust } from './remoteTrust.js';
import { activeWindowTitle } from './laptop/activeWindow.js';
import { RemotePin, parseSpokenPin } from './remotePin.js';
import { Passkeys } from './passkeys.js';
import { createWakeSampleStore, suggestThreshold } from './voice/wakeSamples.js';
import { createPush } from './push.js';
import { createMissedQueue } from './missed.js';
import { createTailscaleIdentity } from './tailscaleIdentity.js';
import { PairRequests } from './pairRequests.js';
import { enrollVoice, readClips, createVoiceprintStore } from './voice/speaker/enroll.js';

export function createNovi(config, overrides = {}) {
  const memory = overrides.memory || new Memory(path.join(config.dataDir, 'memory.json'));
  const accounts = overrides.accounts || new AccountRegistry(path.join(config.dataDir, 'accounts.json'));
  const secrets = new SecretStore({ file: path.join(config.dataDir, 'secrets.json'), cipher: overrides.cipher || defaultCipher(config.dataDir) });
  const auth = overrides.auth || new GoogleAuth({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, accounts, secrets });
  const gmail = new GmailClient({ getToken: (a) => auth.accessToken(a), invalidate: (a) => auth.invalidate(a.id) });
  // "Always allow" grants by category (Settings → Permissions).
  const grants = overrides.grants || new PermissionGrants(path.join(config.dataDir, 'permissions.json'));
  // What a phone must prove to allow (voice PIN / passkey); the verifiers are filled in below.
  const proofs = {};
  const trust = createRemoteTrust({ pin: (...a) => proofs.pin?.(...a), passkey: (...a) => proofs.passkey?.(...a), hasPasskey: (...a) => proofs.hasPasskey?.(...a) });
  const remotePin = overrides.remotePin || new RemotePin({ file: path.join(config.dataDir, 'remote-pin.json') });
  proofs.pin = (proof) => remotePin.check(proof.pin).ok;
  // Fingerprint / face (passkeys) need the Tailscale name: WebAuthn doesn't work on bare IPs.
  const tsName = overrides.tsName || null;
  const passkeys = overrides.passkeys || (tsName ? new Passkeys({ file: path.join(config.dataDir, 'passkeys.json'), rpId: tsName, origin: `https://${tsName}:${config.port || 3001}` }) : null);
  proofs.hasPasskey = (from) => Boolean(passkeys?.has(from.deviceId));
  proofs.passkey = (proof, from, approval) => proof.passkey?.verified === true && proof.passkey.approvalId === approval.id && proof.passkey.deviceId === from.deviceId;
  const approvals = overrides.approvals || new ApprovalQueue({ grants, trust });
  if (!approvals.trust) approvals.trust = trust;
  const router = overrides.router || new Router({ providers: config.providers, order: config.order });
  // Default coder: Novi Coder (free). Claude Code only when configured, or when the user says "use Claude instead".
  const defaultCoder = config.coder === 'claude' ? 'claude' : 'novi-coder';
  const claudeInstalled = Boolean(config.claudeCommand) && fs.existsSync(config.claudeCommand);
  const tasks = overrides.tasks || new TaskManager({
    memory,
    approvals,
    agentName: defaultCoder === 'claude' ? 'Claude' : 'Novi Coder',
    agentLabels: { 'novi-coder': 'Novi Coder', claude: 'Claude' },
    createSession: (opts) => ((opts.agent || defaultCoder) === 'claude'
      ? new ClaudeSession({ command: config.claudeCommand, ...opts })
      : new FreeCoderSession({ router, ...opts })),
  });
  // Every feature is an OpenClaw-shaped plugin; built-ins wrap the existing tool registries.
  const plugins = new PluginHost({
    runtime: {
      memory, accounts, secrets, tasks, openUrl,
      resolveAccount: (provider, requested, opts) => resolveAccount(accounts, provider, requested, opts),
      askNote,
      speak: (text) => sendTo(active, { type: 'speak', text: plainText(text) }),
      // Image understanding (screen control): Gemini vision; the user agreed screenshots may go to Gemini.
      // A plugin may use another plugin's read-only tools (e.g. the briefing reads weather and calendar).
      // Anything that would need approval (sends, changes, deletes) is refused here.
      callTool: async (name, params = {}) => {
        const tool = plugins.get(name);
        if (!tool) throw new Error(`Unknown tool ${name}`);
        const gate = await tool.gate(params);
        if (gate.block || gate.approval) throw new Error(`${name} needs approval, so a plugin can't run it`);
        return tool.run(params);
      },
      // Signed-in Google API calls for plugins (Calendar, Tasks) on the account connected for Gmail.
      google: overrides.google || createGoogleApi({ auth, accounts }),
      vision: overrides.vision || createGeminiVision({ keys: config.providers.find((p) => p.name === 'gemini')?.keys || [] }),
      // Chat entry + spoken (e.g. a reminder going off), and a folder for plugin data files.
      // kind: what the phone notification says if Novi isn't open there ('reminder', 'briefing');
      // null = no notification. local: on the laptop only (e.g. "last time on NOVI…" when an editor opens).
      say: (text, { kind = 'reminder', local = false } = {}) => {
        const to = local ? 'local' : active;
        say('novi', text, to);
        sendTo(to, { type: 'speak', text: plainText(text) });
        if (kind) notify(kind, to);
      },
      // One AI answer on the private provider only (Groq) — for plugin summaries of private data.
      privateComplete: async (text) => {
        const res = await router.chat({ messages: [{ role: 'user', content: String(text) }], purpose: 'fast', only: (config.privateProviders || ['groq'])[0] });
        return String(res.message?.content || '').trim();
      },
      // Title of the window in front on the laptop (no screenshot).
      activeWindowTitle: overrides.activeWindowTitle || activeWindowTitle,
      // A phone notification only (fixed, private-free text per kind; see server/push.js).
      notify: ({ kind } = {}) => notify(kind),
      // A picture (screenshot) for whoever asked. Only the caption is kept in the transcript.
      showImage: ({ png, caption = '' }) => {
        const at = new Date().toISOString();
        transcript.push({ role: 'novi', text: caption, at, device: deviceKey(active) });
        sendTo(active, { type: 'chat', entry: { role: 'novi', text: caption, at, image: `data:image/png;base64,${Buffer.from(png).toString('base64')}` } });
      },
      dataDir: config.dataDir, logger: console },
  });
  plugins.register(wrapRegistryAsPlugin({ id: 'coding', name: 'Coding tasks', registry: createNoviTools({ memory, tasks, coder: defaultCoder, alternativeAvailable: defaultCoder === 'claude' || claudeInstalled }) }));
  plugins.register(wrapRegistryAsPlugin({ id: 'laptop', name: 'Laptop basics', registry: addLaptopTools(new ToolRegistry(), overrides.laptop) }));
  plugins.register(wrapRegistryAsPlugin({
    id: 'accounts',
    name: 'Accounts and Gmail',
    registry: addAccountTools(new ToolRegistry(), { accounts, auth, gmail, onConnected: (a) => onConnected(a), onConnectError: (e) => onConnectError(e) }),
  }));
  const tools = plugins;
  const agent = overrides.agent || new Agent({ router, tools, approvals, memory, tasks, accounts, privateProviders: config.privateProviders || ['groq'] });
  const pairing = overrides.pairing || new Pairing({ file: path.join(config.dataDir, 'devices.json') });
  const tailscaleIdentity = overrides.tailscaleIdentity || createTailscaleIdentity();
  const pairRequests = new PairRequests({ issue: (name) => pairing.issue(name, 'laptop') });
  const providerKeys = (name) => config.providers.find((p) => p.name === name)?.keys || [];
  // Groq Whisper first (free, good English). Hindi / Marathi clips go on to Sarvam, which is
  // also the backup when Groq is down; Gemini last (it timed out often in the 2026-10-07 benchmark).
  const sarvam = createSarvamStt({ keys: config.speechKeys?.sarvam || [] });
  const speech = createSpeechEngine({ stt: [createGroqWhisperStt({ keys: providerKeys('groq') }), sarvam, createGeminiStt({ keys: providerKeys('gemini') })], indic: sarvam });
  const stt = overrides.transcribe || (async (audio, mimeType) => {
    const result = await speech.transcribe({ audio, mimeType });
    if (result.fallbackFrom.length) console.warn(`[voice] ${result.fallbackFrom.join(', ')} failed; used ${result.provider}`);
    if (result.refinedFrom) console.log(`[voice] Hindi/Marathi: used ${result.provider} instead of ${result.refinedFrom}`);
    return result.text;
  });
  const lanUrls = overrides.lanUrls || [];
  // Browsers attach Origin to WebSocket and cross-site requests. Because localhost is
  // trusted, any other website open in the laptop's browser could otherwise drive Novi
  // (start tasks, approve commands). Only Novi's own pages are allowed; non-browser
  // clients send no Origin and still go through the localhost/token checks.
  const port = config.port || 3001;
  const allowedOrigins = new Set([
    ...lanUrls,
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  const originAllowed = (req) => !req.headers.origin || allowedOrigins.has(req.headers.origin);

  const clients = new Set();
  // Phone notifications + spoken lines a phone missed while Novi wasn't open on it.
  const push = overrides.push || createPush({ dir: path.join(config.dataDir, 'push') });
  const missed = createMissedQueue();
  const transcript = [];
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  // With no Novi page open, spoken lines go to the laptop speakers instead (Windows voice).
  const localSpeaker = overrides.localSpeaker || null;
  // The wake listener must know when the laptop is talking ("Hey Novi" then interrupts it).
  let wakeTools = null; // { capture, setThreshold, threshold, setSpeaking } from the wake-word service
  let talking = 0;
  const speakLocal = (text) => {
    if (!localSpeaker) return;
    if (++talking === 1) wakeTools?.setSpeaking?.(true);
    Promise.resolve(localSpeaker(text)).catch(() => {}).finally(() => {
      if (--talking === 0) wakeTools?.setSpeaking?.(false);
    });
  };
  const broadcast = (msg) => {
    for (const ws of clients) send(ws, msg);
    if (msg.type === 'speak' && clients.size === 0 && msg.text) speakLocal(msg.text);
  };
  // Replies go only to the device that asked: 'local' = the laptop (its pages, else its speakers),
  // { deviceId } = that phone. `active` is whoever spoke to Novi last — task updates, reminders and
  // approval prompts are spoken there.
  let active = 'local';
  const deviceKey = (from) => (from === 'local' || !from ? 'local' : from.deviceId);
  const viewerKey = (ws) => ws.deviceId || 'local';
  const sendTo = (from, msg) => {
    const key = deviceKey(from);
    let reached = 0;
    for (const ws of clients) if (viewerKey(ws) === key) { send(ws, msg); reached += 1; }
    if (msg.type === 'speak' && msg.text && !reached && key === 'local') speakLocal(msg.text);
    // A phone that doesn't have Novi open hears it later (and gets a notification, see notify()).
    if (msg.type === 'speak' && msg.text && !reached && key !== 'local') missed.add(key, msg.text);
  };
  const isOpen = (key) => [...clients].some((ws) => viewerKey(ws) === key);
  // Phone notification for the device used last, only when Novi isn't open there.
  const notify = (kind, to = active) => {
    const key = deviceKey(to);
    if (key === 'local' || isOpen(key)) return;
    push.send(key, { kind }).catch(() => {});
  };
  const refresh = () => { for (const ws of clients) send(ws, snapshot(viewerKey(ws))); };
  const accountsView = () => accounts.list().map((a) => ({ id: a.id, provider: a.provider, label: a.label, email: a.email, status: a.status, isDefault: accounts.defaultFor(a.provider)?.id === a.id }));
  const onConnected = (a) => {
    const text = `Gmail connected: ${a.email}. I'll call it ${a.label}.`;
    say('novi', text);
    sendTo(active, { type: 'speak', text });
    refresh();
  };
  const onConnectError = (e) => {
    say('novi', e.message);
    sendTo(active, { type: 'speak', text: e.message });
  };
  // 'server' when the laptop-mic wake word is running (the browser then doesn't listen too).
  let wakeWord = 'browser';
  const snapshot = (viewer = 'local') => ({
    type: 'snapshot',
    wakeWord,
    transcript: transcript.filter((e) => e.device === viewer).map(({ device, ...e }) => e),
    task: tasks.status(),
    approvals: approvals.pending(),
    providers: router.status(),
    projects: memory.listProjects(),
    devices: pairing.listDevices(),
    // Phones asking to connect: only the laptop sees (and answers) them.
    pairRequests: viewer === 'local' ? pairRequests.pending() : [],
    accounts: accountsView(),
    googleConfigured: auth.configured,
  });
  const say = (role, text, to = active) => {
    const entry = { role, text, at: new Date().toISOString() };
    transcript.push({ ...entry, device: deviceKey(to) });
    if (transcript.length > 100) transcript.splice(0, transcript.length - 100);
    sendTo(to, { type: 'chat', entry });
  };

  tasks.on('feed', (f) => broadcast({ type: 'feed', ...f }));
  tasks.on('speak', (text) => sendTo(active, { type: 'speak', text }));
  const notifiedTasks = new Set();
  tasks.on('task', (task) => {
    broadcast({ type: 'task', task });
    const key = `${task.id}:${task.status}`;
    if ((task.status === 'done' || task.status === 'failed') && !notifiedTasks.has(key)) {
      notifiedTasks.add(key);
      notify(task.status === 'done' ? 'task_done' : 'task_failed');
    }
  });
  approvals.on('added', (approval) => {
    broadcast({ type: 'approval_added', approval });
    notify('approval');
    sendTo(active, { type: 'speak', text: approval.tier === 'high' ? `High risk: ${approval.title}. Please confirm on screen.` : approval.prompt || `${approval.title}. Should I allow it?` });
  });
  approvals.on('resolved', (r) => broadcast({ type: 'approval_resolved', ...r }));
  // Only the phone that tried hears what is missing.
  const NEED_TEXT = { pin: 'Say your PIN to confirm.', passkey: 'Confirm with your fingerprint or face.', laptop: 'This one needs you at the laptop.' };
  remotePin.on('locked', () => {
    broadcast({ type: 'feed', text: 'Wrong PIN 3 times: approvals from phones that need the PIN are locked for 15 minutes.' });
    // A security alert: every device hears it.
    broadcast({ type: 'speak', text: 'Wrong PIN 3 times. Phone approvals that need the PIN are locked for 15 minutes.' });
    for (const device of pairing.listDevices()) notify('pin_locked', { deviceId: device.id });
  });
  approvals.on('needs_proof', ({ id, need, from }) => {
    for (const ws of clients) {
      if (ws.deviceId !== from?.deviceId) continue;
      send(ws, { type: 'approval_needs_proof', id, need });
      send(ws, { type: 'speak', text: NEED_TEXT[need] });
    }
  });
  // Allowed by a grant without asking: a quiet line in the activity feed, not spoken.
  approvals.on('auto_allowed', ({ title }) => broadcast({ type: 'feed', text: `Auto-allowed: ${title}` }));

  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  // Loopback = the laptop itself. Everything else (LAN, Tailscale 100.x) must be a paired device.
  const localAddress = overrides.isLocalAddress || isLocalAddress;
  const isLocal = (req) => localAddress(req.socket.remoteAddress);

  const app = express();
  app.use('/api', (req, res, next) => (originAllowed(req) ? next() : res.status(403).json({ error: 'Cross-site request blocked' })));
  app.use(express.json({ limit: '100kb' }));
  // Pairing, three easy ways (no typed code):
  //  1. /api/pair         — the one-time code inside the QR shown on the laptop
  //  2. /api/pair/auto    — a phone on the laptop owner's own Tailscale account gets in by itself
  //  3. /api/pair/request — "Ask the laptop": Allow / Deny on the laptop, phone picks up its token
  app.post('/api/pair', (req, res) => {
    const result = pairing.pair(req.body?.code, req.body?.name);
    res.status(result.ok ? 200 : 401).json(result);
  });
  app.post('/api/pair/auto', async (req, res) => {
    const device = await tailscaleIdentity.ownerDevice(req.socket.remoteAddress);
    if (!device) return res.status(403).json({ error: 'Not a device on your own Tailscale account.' });
    res.json(pairing.issue(device.name, 'tailscale'));
    refresh();
  });
  app.post('/api/pair/request', (req, res) => {
    try {
      const ask = pairRequests.create({ name: req.body?.name, ip: req.socket.remoteAddress });
      const { name } = pairRequests.pending().find((r) => r.id === ask.id);
      sendTo('local', { type: 'speak', text: `${name} wants to connect. Allow it on the laptop screen.` });
      refresh();
      res.json(ask);
    } catch (err) {
      res.status(429).json({ error: err.message });
    }
  });
  app.get('/api/pair/request/:id', (req, res) => res.json(pairRequests.check(req.params.id, String(req.query.secret || ''))));
  // req.from: who is asking — 'local' (the laptop) or { deviceId } (a paired phone).
  app.use('/api', (req, res, next) => {
    if (isLocal(req)) { req.from = 'local'; return next(); }
    const device = pairing.verify(bearer(req));
    if (!device) return res.status(401).json({ error: 'Not paired' });
    req.from = { deviceId: device.id };
    next();
  });
  app.get('/api/pairing-code', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'The pairing code is only shown on the laptop.' });
    const current = pairing.currentCode();
    // The QR opens Novi on the phone and pairs it with the one-time code (first URL = Tailscale when available).
    res.json({ ...current, urls: lanUrls, qrUrl: lanUrls[0] ? `${lanUrls[0]}/#pair=${current.code}` : null, qrUrls: lanUrls.map((u) => `${u}/#pair=${current.code}`) });
  });
  // Voice test recordings (Settings → Voice test): private clips for benchmarking speech-to-text.
  const samples = createSampleStore({ dir: path.join(config.dataDir, 'voice-samples') });
  app.get('/api/voice-samples', (req, res) => res.json({ phrases: TEST_PHRASES, recorded: samples.recordedIds() }));
  app.post('/api/voice-samples/:phraseId', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    try {
      const mimeType = String(req.headers['content-type'] || 'audio/wav').split(';')[0];
      res.json(samples.save({ phraseId: req.params.phraseId, audio: req.body, mimeType }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  // Settings → Permissions: "always allow" grants and what they allowed.
  // "Hey Novi" practice clips through the laptop wake-word mic (Settings → Voice), laptop only.
  // wakeTools ({ capture, setThreshold, threshold }) come from the wake-word service once it runs.
  const wakeSamples = createWakeSampleStore({ dir: path.join(config.dataDir, 'voice-samples', 'hey-novi'), settingsFile: path.join(config.dataDir, 'wakeword.json') });
  const wakeInfo = () => ({ available: Boolean(wakeTools), ...wakeSamples.list(), threshold: wakeSamples.threshold() ?? wakeTools?.threshold ?? null, suggested: suggestThreshold(wakeSamples.list().scores) });
  app.get('/api/wake-samples', (req, res) => res.json(wakeInfo()));
  app.post('/api/wake-samples', async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'Record these on the laptop (they use its microphone).' });
    if (!wakeTools) return res.status(409).json({ error: 'The laptop wake word is not running.' });
    const { audio, best } = await wakeTools.capture(2500);
    res.json({ ...wakeSamples.save(audio, best), voiceMatch: checkVoice(audio).score });
  });

  // "Only my voice": the owner's voiceprint, learned from the "Hey Novi" practice clips. The
  // speaker model comes from the wake-word service (setSpeakerVerifier); no model = check off.
  let speaker = { verifier: null, status: 'no-model' };
  const voiceprints = createVoiceprintStore({ file: path.join(config.dataDir, 'voiceprint.json') });
  const heyNoviDir = path.join(config.dataDir, 'voice-samples', 'hey-novi');
  const usableVoiceprint = () => {
    const saved = voiceprints.get();
    return speaker.verifier && saved?.enabled && saved.voiceprint.length === speaker.verifier.dim ? saved : null;
  };
  // ok: true = the owner, false = someone else, null = check off (never makes Novi deaf).
  function checkVoice(audio) {
    const saved = usableVoiceprint();
    if (!saved) return { ok: null, score: null };
    try {
      const score = Math.round(speaker.verifier.score(speaker.verifier.embed(audio), saved.voiceprint) * 1000) / 1000;
      return { ok: score >= saved.strictness, score };
    } catch {
      return { ok: null, score: null };
    }
  }
  const speakerCheck = () => {
    if (!speaker.verifier) return speaker.status === 'error' ? 'error' : 'no-model';
    const saved = voiceprints.get();
    if (saved?.enabled && saved.voiceprint.length !== speaker.verifier.dim) return 'relearn';
    return saved?.enabled ? 'on' : 'off';
  };
  const voiceInfo = () => ({ available: speaker.status === 'ready', status: speaker.status, check: speakerCheck(), ...voiceprints.summary() });
  app.get('/api/voiceprint', (req, res) => res.json(voiceInfo()));
  app.post('/api/voiceprint/learn', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'Learn your voice on the laptop.' });
    if (!speaker.verifier) return res.status(409).json({ error: 'Speaker model not installed.' });
    try {
      voiceprints.save(enrollVoice({ verifier: speaker.verifier, clips: readClips(heyNoviDir) }), { model: speaker.verifier.model });
      res.json(voiceInfo());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.put('/api/voiceprint', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'This can only be changed on the laptop.' });
    try {
      voiceprints.update({ enabled: req.body?.enabled, strictness: req.body?.strictness });
      res.json(voiceInfo());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.put('/api/wake-samples/threshold', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'This can only be changed on the laptop.' });
    try {
      wakeSamples.setThreshold(req.body?.threshold);
      wakeTools?.setThreshold(wakeSamples.threshold());
      res.json(wakeInfo());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Phone notifications: the phone subscribes once (Settings → Enable notifications).
  app.get('/api/push/key', (req, res) => res.json({ publicKey: push.publicKey, subscribed: req.from !== 'local' && Boolean(push.has?.(req.from.deviceId)) }));
  app.post('/api/push/subscribe', (req, res) => {
    if (req.from === 'local') return res.status(400).json({ error: 'Turn on notifications from your phone.' });
    try { push.subscribe(req.from.deviceId, req.body); res.json({ subscribed: true }); } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Voice PIN for high-risk approvals from a phone: set and changed at the laptop only.
  app.post('/api/pair/requests/:id', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'Only the laptop can let a phone in.' });
    const ok = pairRequests.decide(req.params.id, req.body?.allow === true);
    refresh();
    res.status(ok ? 200 : 404).json({ ok });
  });
  app.get('/api/remote-pin', (req, res) => res.json({ set: remotePin.isSet(), ...remotePin.getSettings(), lockedUntil: remotePin.lockedUntil || 0 }));
  app.post('/api/remote-pin', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'The PIN can only be set on the laptop.' });
    try { remotePin.set(String(req.body?.pin ?? '')); res.json({ set: true }); } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.put('/api/remote-pin/settings', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'This can only be changed on the laptop.' });
    try { remotePin.setSettings({ pinInput: req.body?.pinInput }); res.json(remotePin.getSettings()); } catch (err) { res.status(400).json({ error: err.message }); }
  });
  // Passkeys: a paired phone sets up its fingerprint / face, then signs one challenge per approval.
  const phoneOnly = (req, res) => {
    if (!passkeys) { res.status(409).json({ error: 'Fingerprint / face needs Novi opened through its Tailscale address.' }); return null; }
    if (req.from === 'local') { res.status(400).json({ error: 'Set this up from your phone.' }); return null; }
    return req.from.deviceId;
  };
  app.post('/api/passkeys/register/options', async (req, res) => {
    const deviceId = phoneOnly(req, res);
    if (deviceId) res.json(await passkeys.registrationOptions(deviceId));
  });
  app.post('/api/passkeys/register/verify', express.json({ limit: '64kb' }), async (req, res) => {
    const deviceId = phoneOnly(req, res);
    if (!deviceId) return;
    const ok = await passkeys.verifyRegistration(deviceId, req.body);
    res.status(ok ? 200 : 400).json(ok ? { registered: true } : { error: "Couldn't confirm the fingerprint / face. Try again." });
  });
  app.get('/api/passkeys', (req, res) => res.json({ available: Boolean(passkeys), registered: req.from !== 'local' && Boolean(passkeys?.has(req.from.deviceId)) }));
  app.post('/api/passkeys/auth/options', async (req, res) => {
    const deviceId = phoneOnly(req, res);
    if (!deviceId) return;
    try { res.json(await passkeys.authOptions(deviceId, String(req.body?.approvalId || ''))); } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.get('/api/permissions', (req, res) => res.json({ grants: grants.list(), audit: grants.audit().slice(0, 20) }));
  app.delete('/api/permissions/:category', (req, res) => res.json({ revoked: grants.revoke(req.params.category) }));

  // Settings → System: is Novi healthy, and a restart button (only under the supervisor).
  const system = { version: 'dev', supervised: false, restarts: 0, ...overrides.system };
  const startedAt = Date.now();
  const backupsDir = overrides.backupsDir || path.resolve('backups');
  const lastBackup = () => {
    if (!fs.existsSync(backupsDir)) return null;
    const file = fs.readdirSync(backupsDir).filter((f) => /^novi-data-.*\.zip$/.test(f)).sort().at(-1);
    return file ? { file, at: fs.statSync(path.join(backupsDir, file)).mtime.toISOString() } : null;
  };
  app.get('/api/health', (req, res) => res.json({
    version: system.version,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    supervised: system.supervised,
    restarts: system.restarts,
    wakeWord,
    speakerCheck: speakerCheck(),
    providers: router.status(),
    lastBackup: lastBackup(),
    errors: overrides.logBuffer?.recent() || [],
  }));
  const exit = overrides.exit || ((code) => process.exit(code));
  app.post('/api/restart', (req, res) => {
    if (!system.supervised) return res.status(409).json({ error: 'Novi was started without the supervisor, so it cannot restart itself. Close it and double-click Start Novi.cmd.' });
    res.json({ restarting: true });
    setTimeout(() => exit(75), 300);
  });
  // Natural voices for spoken replies (Edge neural voices); the browser falls back to its own voice on error.
  const tts = overrides.tts || createEdgeTts({ voices: {
    en: process.env.NOVI_TTS_VOICE_EN || DEFAULT_VOICES.en,
    hi: process.env.NOVI_TTS_VOICE_HI || DEFAULT_VOICES.hi,
    mr: process.env.NOVI_TTS_VOICE_MR || DEFAULT_VOICES.mr,
  } });
  app.post('/api/tts', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const audio = await tts(String(req.body?.text || ''));
      res.type('audio/mpeg').send(audio);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  app.post('/api/stt', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
    try {
      const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const t0 = Date.now();
      const text = await stt(req.body, mimeType);
      // Where the time goes (tap → mic open on the phone, speech-to-text here). Never logs the words.
      console.log(`[timing] mic open ${Number(req.headers['x-novi-mic-ms']) || '?'} ms, speech-to-text ${Date.now() - t0} ms (${Math.round(req.body.length / 1024)} KB)`);
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  app.post('/api/accounts/google/connect', async (req, res) => {
    try {
      const { url, done } = await auth.connect();
      done.then(onConnected, onConnectError);
      res.json({ url });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.post('/api/accounts/github/connect', async (req, res) => {
    const tool = plugins.get('github_connect');
    if (!tool) return res.status(404).json({ error: 'The GitHub plugin is not loaded.' });
    try {
      const out = await tool.run({});
      res.status(out.error ? 400 : 200).json(out);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  app.patch('/api/accounts/:id', (req, res) => {
    const account = accounts.get(req.params.id);
    if (!account) return res.status(404).json({ error: 'No such account' });
    try {
      if (typeof req.body?.label === 'string') accounts.setLabel(account.id, req.body.label);
      if (req.body?.default === true) accounts.setDefault(account.provider, account.id);
      if (req.body?.default === false) accounts.setDefault(account.provider, null);
      res.json({ ok: true });
      refresh();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete('/api/accounts/:id', async (req, res) => {
    if (!accounts.get(req.params.id)) return res.status(404).json({ error: 'No such account' });
    const account = accounts.get(req.params.id);
    if (account.provider === 'google') await auth.disconnect(account.id);
    else {
      // Other providers: forget the key locally (revoke remains available on the provider's site).
      secrets.delete(account.id);
      accounts.remove(account.id);
    }
    res.json({ removed: true });
    refresh();
  });
  app.delete('/api/devices/:id', (req, res) => {
    passkeys?.removeDevice(req.params.id);
    push.removeDevice(req.params.id);
    missed.clear(req.params.id);
    res.json({ revoked: pairing.revoke(req.params.id) });
    refresh();
  });
  app.delete('/api/projects/:name', (req, res) => {
    res.json({ forgotten: memory.forgetProject(req.params.name) });
    refresh();
  });

  // Voice-activity detection (Silero VAD) runs in the browser; serve its model and runtime
  // from node_modules so it works offline. Only these files, nothing else from node_modules.
  const VAD_FILES = {
    'vad.worklet.bundle.min.js': 'node_modules/@ricky0123/vad-web/dist',
    'silero_vad_v5.onnx': 'node_modules/@ricky0123/vad-web/dist',
    'ort-wasm-simd-threaded.wasm': 'node_modules/onnxruntime-web/dist',
    'ort-wasm-simd-threaded.mjs': 'node_modules/onnxruntime-web/dist',
    'ort-wasm-simd-threaded.jsep.wasm': 'node_modules/onnxruntime-web/dist',
    'ort-wasm-simd-threaded.jsep.mjs': 'node_modules/onnxruntime-web/dist',
  };
  app.get('/vad/:file', (req, res) => {
    const dir = VAD_FILES[req.params.file];
    if (!dir) return res.status(404).end();
    res.sendFile(path.resolve(dir, req.params.file));
  });

  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // Proof a phone sent with its "allow": a spoken PIN (or typed, if Settings allow it).
  // The PIN is only checked here — never shown, logged, or passed to the brain.
  async function approvalProof(msg, from) {
    const proof = {};
    const typedOk = remotePin.getSettings().pinInput === 'voice-or-typed';
    const pin = typeof msg.pinSpoken === 'string' ? parseSpokenPin(msg.pinSpoken) : typedOk && typeof msg.pinTyped === 'string' ? parseSpokenPin(msg.pinTyped) : null;
    if (pin) proof.pin = pin;
    else if (typeof msg.pinSpoken === 'string' || (typedOk && typeof msg.pinTyped === 'string')) proof.pin = '';
    // The signature is checked here; the trust rules only ever see this server-made marker.
    if (msg.passkey && typeof msg.passkey === 'object' && from !== 'local' && passkeys
      && await passkeys.verifyAuth(from.deviceId, msg.id, msg.passkey)) {
      proof.passkey = { verified: true, approvalId: msg.id, deviceId: from.deviceId };
    }
    return proof;
  }

  async function handleMessage(msg, from = 'local') {
    if (msg.type === 'user_message' && typeof msg.text === 'string' && msg.text.trim()) {
      const text = msg.text.trim().slice(0, 4000);
      active = from;
      say('user', text, from);
      sendTo(from, { type: 'thinking', on: true });
      try {
        const t0 = Date.now();
        const reply = await agent.handle(text, { from });
        console.log(`[timing] reply ${Date.now() - t0} ms`);
        say('novi', reply, from);
        sendTo(from, { type: 'speak', text: spokenText(reply) });
        return reply;
      } catch (err) {
        say('novi', `Something went wrong: ${err.message}`, from);
      } finally {
        sendTo(from, { type: 'thinking', on: false });
        refresh();
      }
    } else if (msg.type === 'approval') {
      approvals.resolve(msg.id, Boolean(msg.allow), 'screen', typeof msg.choice === 'string' ? msg.choice : null, { always: msg.always === true, from, proof: await approvalProof(msg, from) });
    } else if (msg.type === 'allow_edits') {
      tasks.setAllowEdits(Boolean(msg.allow));
    } else if (msg.type === 'stop') {
      await tasks.stop();
    }
  }

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      if (!originAllowed(req)) {
        ws.close(4003, 'Cross-site connection blocked');
        return;
      }
      const local = localAddress(req.socket.remoteAddress);
      let authed = local;
      let token = null;
      const admit = () => {
        clients.add(ws);
        send(ws, snapshot(viewerKey(ws)));
        // What this phone missed while Novi wasn't open on it, spoken in order.
        const lines = ws.deviceId ? missed.take(ws.deviceId) : [];
        if (lines.length) send(ws, { type: 'missed', lines });
      };
      if (authed) admit();
      ws.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!authed) {
          const paired = msg.type === 'hello' && pairing.verify(msg.token);
          if (paired) { authed = true; token = msg.token; ws.deviceId = paired.id; admit(); } else ws.close(4001, 'Not paired');
          return;
        }
        if (msg.type === 'hello') return;
        // A phone removed in Settings loses its open connection on its next message.
        const device = local ? null : pairing.verify(token);
        if (!local && !device) { clients.delete(ws); ws.close(4001, 'Not paired'); return; }
        await handleMessage(msg, local ? 'local' : { deviceId: device.id });
      });
      ws.on('close', () => clients.delete(ws));
    });
    return wss;
  }

  // A command heard by the always-on laptop microphone (16 kHz WAV).
  async function runVoiceCommand(wav) {
    const text = String(await stt(wav, 'audio/wav')).trim();
    if (!text || text === '.') return null;
    // What was heard and Novi's reply: the wake-word service uses them for conversation mode.
    return { text, reply: (await handleMessage({ type: 'user_message', text })) || '' };
  }
  const setWakeTools = (tools) => { wakeTools = tools; };
  // Trigger level chosen in Settings (from the user's own clips), if any.
  const wakeThreshold = () => wakeSamples.threshold();
  const setWakeWord = (mode) => { wakeWord = mode; refresh(); };
  const setSpeakerVerifier = (value) => { speaker = value; };
  // "Hey Novi" while Novi talks: silence the laptop voice and any open laptop page.
  const stopSpeaking = () => {
    localSpeaker?.stop?.();
    broadcast({ type: 'stop_speaking' });
  };

  return { app, attachWebSocket, remotePin, setWakeTools, setSpeakerVerifier, checkVoice, stopSpeaking, wakeThreshold, snapshot, runVoiceCommand, setWakeWord, memory, accounts, approvals, tasks, router, agent, tools, plugins, pairing, broadcast };
}
