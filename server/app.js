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
import { TEST_PHRASES, createSampleStore } from './voice/samples.js';
import { plainText } from './narrator.js';
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

export function createNovi(config, overrides = {}) {
  const memory = overrides.memory || new Memory(path.join(config.dataDir, 'memory.json'));
  const accounts = overrides.accounts || new AccountRegistry(path.join(config.dataDir, 'accounts.json'));
  const secrets = new SecretStore({ file: path.join(config.dataDir, 'secrets.json'), cipher: overrides.cipher || defaultCipher(config.dataDir) });
  const auth = overrides.auth || new GoogleAuth({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, accounts, secrets });
  const gmail = new GmailClient({ getToken: (a) => auth.accessToken(a), invalidate: (a) => auth.invalidate(a.id) });
  // "Always allow" grants by category (Settings → Permissions).
  const grants = overrides.grants || new PermissionGrants(path.join(config.dataDir, 'permissions.json'));
  const approvals = overrides.approvals || new ApprovalQueue({ grants });
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
      speak: (text) => broadcast({ type: 'speak', text: plainText(text) }),
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
      say: (text) => {
        say('novi', text);
        broadcast({ type: 'speak', text: plainText(text) });
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
  const providerKeys = (name) => config.providers.find((p) => p.name === name)?.keys || [];
  // Groq Whisper first, Gemini as backup when Groq is down or out of quota.
  const speech = createSpeechEngine({ stt: [createGroqWhisperStt({ keys: providerKeys('groq') }), createGeminiStt({ keys: providerKeys('gemini') })] });
  const stt = overrides.transcribe || (async (audio, mimeType) => {
    const result = await speech.transcribe({ audio, mimeType });
    if (result.fallbackFrom.length) console.warn(`[voice] ${result.fallbackFrom.join(', ')} failed; used ${result.provider}`);
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
  const transcript = [];
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  // With no Novi page open, spoken lines go to the laptop speakers instead (Windows voice).
  const localSpeaker = overrides.localSpeaker || null;
  const broadcast = (msg) => {
    for (const ws of clients) send(ws, msg);
    if (msg.type === 'speak' && clients.size === 0 && msg.text) localSpeaker?.(msg.text);
  };
  const accountsView = () => accounts.list().map((a) => ({ id: a.id, provider: a.provider, label: a.label, email: a.email, status: a.status, isDefault: accounts.defaultFor(a.provider)?.id === a.id }));
  const onConnected = (a) => {
    const text = `Gmail connected: ${a.email}. I'll call it ${a.label}.`;
    say('novi', text);
    broadcast({ type: 'speak', text });
    broadcast(snapshot());
  };
  const onConnectError = (e) => {
    say('novi', e.message);
    broadcast({ type: 'speak', text: e.message });
  };
  // 'server' when the laptop-mic wake word is running (the browser then doesn't listen too).
  let wakeWord = 'browser';
  const snapshot = () => ({
    type: 'snapshot',
    wakeWord,
    transcript,
    task: tasks.status(),
    approvals: approvals.pending(),
    providers: router.status(),
    projects: memory.listProjects(),
    devices: pairing.listDevices(),
    accounts: accountsView(),
    googleConfigured: auth.configured,
  });
  const say = (role, text) => {
    const entry = { role, text, at: new Date().toISOString() };
    transcript.push(entry);
    if (transcript.length > 100) transcript.splice(0, transcript.length - 100);
    broadcast({ type: 'chat', entry });
  };

  tasks.on('feed', (f) => broadcast({ type: 'feed', ...f }));
  tasks.on('speak', (text) => broadcast({ type: 'speak', text }));
  tasks.on('task', (task) => broadcast({ type: 'task', task }));
  approvals.on('added', (approval) => {
    broadcast({ type: 'approval_added', approval });
    broadcast({ type: 'speak', text: approval.tier === 'high' ? `High risk: ${approval.title}. Please confirm on screen.` : approval.prompt || `${approval.title}. Should I allow it?` });
  });
  approvals.on('resolved', (r) => broadcast({ type: 'approval_resolved', ...r }));
  // Allowed by a grant without asking: a quiet line in the activity feed, not spoken.
  approvals.on('auto_allowed', ({ title }) => broadcast({ type: 'feed', text: `Auto-allowed: ${title}` }));

  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  const isLocal = (req) => isLocalAddress(req.socket.remoteAddress);

  const app = express();
  app.use('/api', (req, res, next) => (originAllowed(req) ? next() : res.status(403).json({ error: 'Cross-site request blocked' })));
  app.use(express.json({ limit: '100kb' }));
  app.post('/api/pair', (req, res) => {
    const result = pairing.pair(req.body?.code, req.body?.name);
    res.status(result.ok ? 200 : 401).json(result);
  });
  app.use('/api', (req, res, next) => (isLocal(req) || pairing.verify(bearer(req)) ? next() : res.status(401).json({ error: 'Not paired' })));
  app.get('/api/pairing-code', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'The pairing code is only shown on the laptop.' });
    res.json({ ...pairing.currentCode(), urls: lanUrls });
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
      res.json({ text: await stt(req.body, mimeType) });
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
      broadcast(snapshot());
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
    broadcast(snapshot());
  });
  app.delete('/api/devices/:id', (req, res) => {
    res.json({ revoked: pairing.revoke(req.params.id) });
    broadcast(snapshot());
  });
  app.delete('/api/projects/:name', (req, res) => {
    res.json({ forgotten: memory.forgetProject(req.params.name) });
    broadcast(snapshot());
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

  async function handleMessage(msg) {
    if (msg.type === 'user_message' && typeof msg.text === 'string' && msg.text.trim()) {
      const text = msg.text.trim().slice(0, 4000);
      say('user', text);
      broadcast({ type: 'thinking', on: true });
      try {
        const reply = await agent.handle(text);
        say('novi', reply);
        broadcast({ type: 'speak', text: plainText(reply) });
      } catch (err) {
        say('novi', `Something went wrong: ${err.message}`);
      } finally {
        broadcast({ type: 'thinking', on: false });
        broadcast(snapshot());
      }
    } else if (msg.type === 'approval') {
      approvals.resolve(msg.id, Boolean(msg.allow), 'screen', typeof msg.choice === 'string' ? msg.choice : null, { always: msg.always === true });
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
      let authed = isLocalAddress(req.socket.remoteAddress);
      const admit = () => { clients.add(ws); send(ws, snapshot()); };
      if (authed) admit();
      ws.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!authed) {
          if (msg.type === 'hello' && pairing.verify(msg.token)) { authed = true; admit(); } else ws.close(4001, 'Not paired');
          return;
        }
        if (msg.type !== 'hello') await handleMessage(msg);
      });
      ws.on('close', () => clients.delete(ws));
    });
    return wss;
  }

  // A command heard by the always-on laptop microphone (16 kHz WAV).
  async function runVoiceCommand(wav) {
    const text = String(await stt(wav, 'audio/wav')).trim();
    if (!text || text === '.') return;
    await handleMessage({ type: 'user_message', text });
  }
  const setWakeWord = (mode) => { wakeWord = mode; broadcast(snapshot()); };

  return { app, attachWebSocket, snapshot, runVoiceCommand, setWakeWord, memory, accounts, approvals, tasks, router, agent, tools, plugins, pairing, broadcast };
}
