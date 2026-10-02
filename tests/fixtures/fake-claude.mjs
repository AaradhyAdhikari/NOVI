// Test double for `claude -p --input-format stream-json --output-format stream-json ...`.
import readline from 'node:readline';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : 'fake-session-1';
const pending = new Map();
let turn = 0;

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), tools: [] });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    if (msg.request.subtype === 'interrupt') {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted', session_id: sessionId, num_turns: turn });
      process.exit(0);
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type === 'control_response') {
    const resolve = pending.get(msg.response.request_id);
    pending.delete(msg.response.request_id);
    resolve?.(msg.response.response);
    return;
  }
  if (msg.type === 'user') runTurn(msg.message.content);
});
rl.on('close', () => process.exit(0));

function ask(toolName, input) {
  return new Promise((resolve) => {
    const id = `perm-${turn}-${Math.random().toString(36).slice(2)}`;
    pending.set(id, resolve);
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: toolName, input, description: 'login.js', tool_use_id: `tu-${id}` } });
  });
}

async function runTurn(text) {
  turn += 1;
  if (text.includes('HANG')) return; // simulates a long task for stop() tests
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: 'src/app.js' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-read', content: 'console.log(1)' }] } });
  const decision = await ask('Write', { file_path: 'src/login.js', content: 'x' });
  const allowed = decision.behavior === 'allow';
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-write', name: 'Write', input: { file_path: 'src/login.js' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-write', is_error: !allowed, content: allowed ? 'File created' : 'Permission denied by user' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `Did: ${text}` }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: allowed ? `Finished: ${text}. All good.` : 'Could not write file', session_id: sessionId, num_turns: turn });
}
