// Understanding test: runs the owner's everyday commands (tools/my-commands.json) through Novi's
// brain as a dry run (agent.firstStep: nothing is opened, sent or set) and reports which ones
// Novi gets wrong. Usage: node --env-file-if-exists=.env tools/understanding-benchmark.mjs
// Uses the free AI keys in .env (a few seconds per command, paced for the free tier).
import fs from 'node:fs';
import path from 'node:path';

const COMMANDS = path.resolve('tools/my-commands.json');

export const loadCommands = (file = COMMANDS) => JSON.parse(fs.readFileSync(file, 'utf8'));

// 'pass' | 'fail' | 'not built'
export function scoreStep(step, want) {
  if (want.notBuilt) return 'not built';
  if (want.quick) return step.quick === want.quick ? 'pass' : 'fail';
  const argsMatch = (args) => Object.entries(want.args || {}).every(([k, pattern]) => new RegExp(pattern, 'i').test(String(args?.[k] ?? '')));
  return (step.calls || []).some((c) => want.tools.includes(c.name) && argsMatch(c.args)) ? 'pass' : 'fail';
}

const describeStep = (s) => (s.quick ? `quick: ${s.quick}` : s.calls.length ? s.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ') : `said: "${String(s.reply).slice(0, 60)}"`);

async function main() {
  const { loadConfig } = await import('../server/config.js');
  const { createNovi } = await import('../server/app.js');
  const novi = createNovi(loadConfig());
  await novi.plugins.loadDirectory(path.resolve('plugins'));
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
  const commands = loadCommands().filter((c) => !only || c.say.toLowerCase().includes(only));
  const results = [];
  for (const c of commands) {
    let step;
    try {
      step = await novi.agent.firstStep(c.say);
    } catch (err) {
      step = { quick: null, calls: [], reply: `ERROR ${err.message}` };
    }
    const result = scoreStep(step, c.expect);
    results.push({ ...c, result, got: describeStep(step) });
    const mark = { pass: '✓', fail: '✗', 'not built': '·' }[result];
    console.log(`${mark} ${c.say}${result === 'fail' ? `\n    wanted ${c.expect.quick || c.expect.tools.join(' or ')}${c.expect.args ? ` ${JSON.stringify(c.expect.args)}` : ''}, got ${describeStep(step)}` : ''}`);
    if (!step.quick) await new Promise((r) => setTimeout(r, 2500));
  }
  const count = (r) => results.filter((x) => x.result === r).length;
  console.log(`\n${count('pass')} understood, ${count('fail')} wrong, ${count('not built')} not built yet (of ${results.length})`);
  const out = path.resolve(`data/understanding-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch((err) => { console.error(err.message); process.exit(1); });
