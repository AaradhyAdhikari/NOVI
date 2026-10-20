import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../../plugins/wiki/vault.js';
import { createNotes } from '../../plugins/wiki/notes.js';
import { createSameThings } from '../../plugins/wiki/sameService.js';
import { parseSame } from '../../plugins/wiki/same.js';

const tmp = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function setup({ titles = [], projects = [], answer = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-samesvc-'));
  tmp.push(dir);
  const vault = createVault(dir);
  vault.ensure();
  const notes = createNotes({ vault, now: () => new Date('2026-10-20T08:00:00Z') });
  for (const t of titles) notes.write({ title: t, text: 'x' });
  const said = [];
  const asked = [];
  const rt = {
    projects: { list: () => projects },
    say: (text) => said.push(text),
    ask: async (card) => { asked.push(card); return { allow: answer }; },
  };
  return { svc: createSameThings({ notes, rt }), notes, said, asked, same: () => parseSame(notes.body('Same things') || '') };
}

describe('Novi joins names that are the same thing', () => {
  it('sure matches go into "Same things" by themselves, and Novi says so once', async () => {
    const s = setup({ titles: ['NOVI CONTEXT project', 'NOVI project', 'medikiiosk project', 'Medikiosk (pinned chat)', 'Portfolio brief', 'ドキュメント project'], projects: [{ name: 'novi' }, { name: 'portfolio' }] });
    await s.svc.check();
    expect(s.same().groups).toEqual([['medikiiosk', 'Medikiosk'], ['NOVI CONTEXT', 'NOVI']]); // novi = NOVI (capitals only); Portfolio = portfolio too
    expect(s.said).toEqual(['I joined names that are the same thing: medikiiosk → Medikiosk; NOVI CONTEXT → NOVI. Say "X and Y are different" if I got one wrong.']);
    await s.svc.check();
    expect(s.said).toHaveLength(1);
  });

  it('a less sure pair is asked once; yes joins them, no keeps them apart for good', async () => {
    const yes = setup({ titles: ['Signsync project', 'Signsyncer project'], answer: true });
    await yes.svc.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(yes.asked[0]).toMatchObject({ title: 'Are Signsync and Signsyncer the same thing?' });
    expect(yes.same().groups).toEqual([['Signsync', 'Signsyncer']]);

    const no = setup({ titles: ['Signsync project', 'Signsyncer project'], answer: false });
    await no.svc.check();
    await new Promise((r) => setTimeout(r, 0));
    await no.svc.check();
    expect(no.asked).toHaveLength(1);
    expect(no.same().different).toEqual([['Signsync', 'Signsyncer']]);
  });

  it('by voice: "X and Y are the same" / "are different" — different splits an earlier merge', () => {
    const s = setup();
    expect(s.svc.set('FlexR', 'Flexr app', true).note).toBe('Okay, FlexR and Flexr app are one thing now.');
    expect(s.svc.aliasesOf('flexr app')).toEqual(['FlexR']);
    expect(s.svc.set('FlexR', 'Flexr app', false).note).toBe('Okay, FlexR and Flexr app stay separate.');
    expect(s.svc.aliasesOf('flexr app')).toEqual([]);
  });
});
