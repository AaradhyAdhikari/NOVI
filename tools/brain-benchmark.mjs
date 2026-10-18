// Retrieval test for the second brain (plugins/brain): runs your real questions (tools/brain-questions.json)
// against the brain on this laptop (data/brain/brain.db) and reports accuracy (right source at #1 / in the
// top 6 that the AI would see), speed, stale results (an old version above the right one) and project
// leaks (another project's file under a project filter). Usage: node tools/brain-benchmark.mjs
// Results also go to data/brain-benchmark-<date>.json. Nothing is changed or sent anywhere.
import fs from 'node:fs';
import path from 'node:path';

export function scoreQuestion(hits, { expect, project, notExpect }) {
  const has = (h, words) => `${h.title} ${h.path || ''}`.toLowerCase().includes(String(words).toLowerCase());
  const at = hits.findIndex((h) => has(h, expect));
  const stale = notExpect ? hits.findIndex((h) => has(h, notExpect)) : -1;
  return {
    top1: at === 0,
    top6: at >= 0 && at < 6,
    rank: at >= 0 ? at + 1 : null,
    stale: stale >= 0 && (at < 0 || stale < at),
    leaks: project ? hits.filter((h) => h.project && h.project !== project.toLowerCase()).length : 0,
  };
}

export function summarize(rows) {
  const n = rows.length || 1;
  const pct = (k) => Math.round((rows.filter((r) => r[k]).length / n) * 100);
  return { questions: rows.length, top1: pct('top1'), top6: pct('top6'), stale: rows.filter((r) => r.stale).length, leaks: rows.reduce((a, r) => a + r.leaks, 0), avgMs: Math.round(rows.reduce((a, r) => a + r.ms, 0) / n) };
}

async function main() {
  const { openStore } = await import('../plugins/brain/store.js');
  const { hybridSearch } = await import('../plugins/brain/search.js');
  const { createEmbedder, MODEL } = await import('../plugins/brain/embed.js');
  const db = path.resolve('data/brain/brain.db');
  if (!fs.existsSync(db)) { console.log('No brain yet: start Novi and let it read your files first.'); return; }
  const store = openStore(db);
  const models = path.resolve('data/brain/models');
  const embedder = fs.existsSync(path.join(models, MODEL.dir, 'model.onnx')) ? createEmbedder({ dir: models }) : null;
  if (embedder) await embedder.start();
  console.log(`Brain: ${JSON.stringify(store.stats())}; meaning search ${embedder?.ready() ? 'on' : 'off'}`);
  const { questions } = JSON.parse(fs.readFileSync(path.resolve('tools/brain-questions.json'), 'utf8'));
  const rows = [];
  for (const q of questions) {
    const t0 = Date.now();
    const hits = await hybridSearch(store, q.q, { embedder, project: q.project?.toLowerCase() || null, limit: 6 });
    const r = { q: q.q, ...scoreQuestion(hits, q), ms: Date.now() - t0, got: hits.slice(0, 3).map((h) => h.title) };
    rows.push(r);
    console.log(`${r.top1 ? '✓' : r.top6 ? '~' : '✗'} ${q.q} → ${r.rank ? `#${r.rank}` : 'not found'} (${r.ms} ms)${r.stale ? ' STALE' : ''}${r.leaks ? ` LEAK ×${r.leaks}` : ''}  [${r.got.join(' | ')}]`);
  }
  const sum = summarize(rows);
  console.log(`\nRight at #1: ${sum.top1}%  ·  in the top 6: ${sum.top6}%  ·  stale: ${sum.stale}  ·  leaks: ${sum.leaks}  ·  ${sum.avgMs} ms each`);
  fs.mkdirSync(path.resolve('data'), { recursive: true });
  fs.writeFileSync(path.resolve(`data/brain-benchmark-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ summary: sum, rows }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
