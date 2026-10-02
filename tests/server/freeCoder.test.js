import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FreeCoderSession } from '../../server/coder/freeCoder.js';
import { AllProvidersUnavailableError } from '../../server/brain/router.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi coder '));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const a = 1;\n');
});

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (toolCalls, content = null, provider = 'gemini') => ({ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, provider, model: 'm' });

function open(steps, { allow = true, maxRounds } = {}) {
  const calls = [];
  const router = {
    calls,
    chat: async (req) => {
      calls.push({ ...req, messages: structuredClone(req.messages) });
      const s = steps[calls.length - 1];
      if (!s) throw new Error('script exhausted');
      if (s instanceof Error) throw s;
      return s;
    },
  };
  const asked = [];
  const events = [];
  const session = new FreeCoderSession({
    router,
    cwd: root,
    maxRounds,
    onPermission: async (req) => { asked.push(req); return allow ? { allow: true } : { allow: false, message: 'Denied by the user.' }; },
  });
  session.on('event', (e) => events.push(e));
  const waitFor = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const hit = events.find(pred); if (hit) return resolve(hit); if (Date.now() - t0 > ms) return reject(new Error(JSON.stringify(events.map((e) => e.kind)))); setTimeout(tick, 10); };
    tick();
  });
  return { session, router, asked, events, waitFor };
}

describe('FreeCoderSession', () => {
  it('emits init with a session id', async () => {
    const { waitFor } = open([]);
    expect((await waitFor((e) => e.kind === 'init')).sessionId).toBeTruthy();
  });

  it('reads, asks before writing, writes, and reports a result on one pinned provider', async () => {
    const { session, router, asked, events, waitFor } = open([
      step([call('a', 'read_file', { path: 'src/app.js' })]),
      step([call('b', 'write_file', { path: 'src/hello.js', content: 'console.log("hello")\n' })]),
      step(null, 'Added src/hello.js.'),
    ]);
    session.send('add hello.js');
    const result = await waitFor((e) => e.kind === 'result');
    expect(result).toMatchObject({ isError: false, text: 'Added src/hello.js.', numTurns: 1 });
    expect(fs.readFileSync(path.join(root, 'src', 'hello.js'), 'utf8')).toBe('console.log("hello")\n');
    expect(asked.map((a) => a.toolName)).toEqual(['Read', 'Write']);
    expect(asked[1].input.file_path).toBe(path.join(root, 'src', 'hello.js'));
    expect(events.filter((e) => e.kind === 'tool_use').map((e) => e.name)).toEqual(['Read', 'Write']);
    expect(router.calls[0].purpose).toBe('long');
    expect(router.calls[1].only).toBe('gemini');
    expect(router.calls[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'a' });
    expect(router.calls[1].messages.at(-1).content).toContain('1\tconst a = 1;');
  });

  it('feeds denials back and does not write', async () => {
    const { session, events, waitFor } = open([
      step([call('b', 'write_file', { path: 'src/hello.js', content: 'x' })]),
      step(null, 'Okay, skipped.'),
    ], { allow: false });
    session.send('add hello.js');
    await waitFor((e) => e.kind === 'result');
    expect(fs.existsSync(path.join(root, 'src', 'hello.js'))).toBe(false);
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: true, content: 'Denied by the user.' });
  });

  it('refuses paths outside the project without asking', async () => {
    const { session, asked, events, waitFor } = open([
      step([call('x', 'write_file', { path: '../evil.js', content: 'x' })]),
      step(null, 'Could not.'),
    ]);
    session.send('escape');
    await waitFor((e) => e.kind === 'result');
    expect(asked).toEqual([]);
    expect(events.find((e) => e.kind === 'tool_result').content).toMatch(/outside the project/);
  });

  it('keeps history across follow-ups', async () => {
    const { session, router, waitFor } = open([step(null, 'One.'), step(null, 'Two.')]);
    session.send('first');
    await waitFor((e) => e.kind === 'result' && e.numTurns === 1);
    session.send('second');
    await waitFor((e) => e.kind === 'result' && e.numTurns === 2);
    expect(router.calls[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('reports busy providers as a failed result', async () => {
    const { session, waitFor } = open([new AllProvidersUnavailableError(9000)]);
    session.send('x');
    const result = await waitFor((e) => e.kind === 'result');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/busy.*9 seconds/);
  });

  it('continues on another provider with compacted history when the pinned one fails', async () => {
    const { session, router, waitFor } = open([
      step([call('a', 'read_file', { path: 'src/app.js' })], null, 'gemini'),
      new AllProvidersUnavailableError(1000),
      step(null, 'Done.', 'groq'),
    ]);
    session.send('look around');
    const result = await waitFor((e) => e.kind === 'result');
    expect(result.text).toBe('Done.');
    expect(router.calls[1].only).toBe('gemini');
    expect(router.calls[2].only).toBeUndefined();
    expect(router.calls[2].messages).toHaveLength(2);
    expect(router.calls[2].messages[1].content).toContain('Earlier in this session');
  });

  it('stop() kills a running command and exits', async () => {
    const { session, events, waitFor } = open([step([call('c', 'run_command', { command: 'node -e "setTimeout(()=>{},20000)"' })])]);
    session.send('long job');
    await waitFor((e) => e.kind === 'tool_use');
    await new Promise((r) => setTimeout(r, 300));
    await session.stop();
    await waitFor((e) => e.kind === 'exit');
    expect(session.exited).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.kind === 'result' && !e.isError)).toBe(false);
  });

  it('gives up after maxRounds', async () => {
    const { session, waitFor } = open([
      step([call('1', 'list_files', {})]),
      step([call('2', 'list_files', {})]),
    ], { maxRounds: 2 });
    session.send('loop');
    expect((await waitFor((e) => e.kind === 'result')).text).toMatch(/Stopped after 2 steps/);
  });
});
