import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../../plugins/wiki/vault.js';
import { buildGraph } from '../../plugins/wiki/graph.js';

// Live 2026-10-20: "NOVI CONTEXT project" and "NOVI project" were two dots for one folder, "medikiiosk"
// (claude.ai) and "Medikiosk" (pinned on ChatGPT) too, and the Documents folder (ドキュメント) was a "▯ project".
const tmp = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function vaultWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-same-'));
  tmp.push(dir);
  const vault = createVault(dir);
  vault.ensure();
  for (const [rel, text] of Object.entries(files)) vault.write(rel, text);
  return vault;
}

describe('graph: one dot per thing ("Same things" note)', () => {
  const g = buildGraph(vaultWith({
    'Notes/Same things.md': '# Same things\n\n- NOVI = NOVI CONTEXT\n- Medikiosk = medikiiosk = MediKiosk AI\n',
    'Notes/NOVI project.md': '# NOVI project\n\nFolder: /nope/novi',
    'Notes/NOVI CONTEXT project.md': '# NOVI CONTEXT project\n\nOn claude.ai: https://claude.ai/project/n\nFolder: /nope/novi',
    'Notes/NOVI (pinned chat).md': '# NOVI (pinned chat)\n\nPinned on ChatGPT: https://chatgpt.com/c/n',
    'Notes/NOVI CONTEXT brief.md': '# NOVI CONTEXT brief\n\nGoal: x',
    'Notes/medikiiosk project.md': '# medikiiosk project\n\nOn claude.ai: https://claude.ai/project/m',
    'Notes/Medikiosk (pinned chat).md': '# Medikiosk (pinned chat)\n\nPinned on ChatGPT: https://chatgpt.com/c/m',
    'Notes/ドキュメント project.md': '# ドキュメント project\n\nFolder: /nope/docs',
  }));
  const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
  const ids = g.nodes.map((n) => n.id);

  it('the two NOVI notes are one dot, named with the shortest clean name, on Claude through either note', () => {
    expect(ids).toContain('Notes/NOVI project.md');
    expect(ids).not.toContain('Notes/NOVI CONTEXT project.md');
    expect(g.nodes.find((n) => n.id === 'Notes/NOVI project.md').title).toBe('NOVI project');
    expect(has('Notes/NOVI project.md', 'Claude')).toBe(true);
    expect(has('Notes/NOVI (pinned chat).md', 'Notes/NOVI project.md')).toBe(true);
    expect(has('Notes/NOVI CONTEXT brief.md', 'Notes/NOVI project.md')).toBe(true);
    expect(g.links.every((l) => ids.includes(l.source) && ids.includes(l.target))).toBe(true);
  });

  it('medikiiosk on claude.ai and the Medikiosk pinned chat meet on one "Medikiosk project" dot', () => {
    expect(g.nodes.find((n) => n.id === 'Notes/medikiiosk project.md').title).toBe('Medikiosk project');
    expect(has('Notes/medikiiosk project.md', 'Claude')).toBe(true);
    expect(has('Notes/Medikiosk (pinned chat).md', 'Notes/medikiiosk project.md')).toBe(true);
    expect(has('Notes/Medikiosk (pinned chat).md', 'ChatGPT')).toBe(true);
  });

  it('the Documents folder is not a project dot; the Claude dot names each project once', () => {
    expect(ids).not.toContain('Notes/ドキュメント project.md');
    expect(g.nodes.find((n) => n.id === 'Claude').excerpt).toBe('Your 2 projects on claude.ai: Medikiosk, NOVI');
  });
});
