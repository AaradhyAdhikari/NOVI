import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Memory } from './memory.js';
import { ApprovalQueue } from './permissions.js';
import { Router } from './brain/router.js';
import { Agent } from './brain/agent.js';
import { TaskManager } from './claude/taskManager.js';
import { ClaudeSession } from './claude/session.js';
import { FreeCoderSession } from './coder/freeCoder.js';
import { createNoviTools } from './tools/noviTools.js';
import { Pairing, isLocalAddress } from './auth.js';
import { transcribe } from './voice/stt.js';
import { plainText } from './narrator.js';

export function createNovi(config, overrides = {}) {
  const memory = overrides.memory || new Memory(path.join(config.dataDir, 'memory.json'));
  const approvals = overrides.approvals || new ApprovalQueue();
  const router = overrides.router || new Router({ providers: config.providers, order: config.order });
  const useClaude = config.coder === 'claude'; // opt-in: uses the user's Claude plan
  const tasks = overrides.tasks || new TaskManager({
    memory,
    approvals,
    agentName: useClaude ? 'Claude' : 'Novi Coder',
    createSession: useClaude
      ? (opts) => new ClaudeSession({ command: config.claudeCommand, ...opts })
      : (opts) => new FreeCoderSession({ router, ...opts }),
  });
  const tools = createNoviTools({ memory, tasks });
  const agent = overrides.agent || new Agent({ router, tools, approvals, memory, tasks });
  const pairing = overrides.pairing || new Pairing({ file: path.join(config.dataDir, 'devices.json') });
  const groqKeys = config.providers.find((p) => p.name === 'groq')?.keys || [];
  const stt = overrides.transcribe || ((audio, mimeType) => transcribe({ audio, mimeType, keys: groqKeys }));
  const lanUrls = overrides.lanUrls || [];

  const clients = new Set();
  const transcript = [];
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const broadcast = (msg) => { for (const ws of clients) send(ws, msg); };
  const snapshot = () => ({
    type: 'snapshot',
    transcript,
    task: tasks.status(),
    approvals: approvals.pending(),
    providers: router.status(),
    projects: memory.listProjects(),
    devices: pairing.listDevices(),
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
    broadcast({ type: 'speak', text: approval.tier === 'high' ? `High risk: ${approval.title}. Please confirm on screen.` : `${approval.title}. Should I allow it?` });
  });
  approvals.on('resolved', (r) => broadcast({ type: 'approval_resolved', ...r }));

  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  const isLocal = (req) => isLocalAddress(req.socket.remoteAddress);

  const app = express();
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
  app.post('/api/stt', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
    try {
      const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      res.json({ text: await stt(req.body, mimeType) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  app.delete('/api/devices/:id', (req, res) => {
    res.json({ revoked: pairing.revoke(req.params.id) });
    broadcast(snapshot());
  });
  app.delete('/api/projects/:name', (req, res) => {
    res.json({ forgotten: memory.forgetProject(req.params.name) });
    broadcast(snapshot());
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
      approvals.resolve(msg.id, Boolean(msg.allow), 'screen');
    } else if (msg.type === 'allow_edits') {
      tasks.setAllowEdits(Boolean(msg.allow));
    } else if (msg.type === 'stop') {
      await tasks.stop();
    }
  }

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
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

  return { app, attachWebSocket, memory, approvals, tasks, router, agent, pairing, broadcast };
}
