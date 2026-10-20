import { parseSame, addSame, findGroups, isContainerName } from './same.js';

// Keeps the "Same things" note (Novi Memory) up to date (user, 2026-10-20: "if you get anything related
// to a single thing, connect it"): every project, pinned chat and brief name Novi knows is compared;
// sure matches are written at once (and said), a less sure pair is asked — one card at a time.
const TITLE = 'Same things';
const INTRO = 'Names that are one thing. Novi adds lines here; edit them freely.\nA line "- A = B" joins names, "- A ≠ B" keeps them apart (it wins over a join).';
const lower = (s) => String(s).toLowerCase();

export function createSameThings({ notes, rt, log = () => {} }) {
  const read = () => (notes.find(TITLE) ? notes.body(notes.find(TITLE)) : '');
  const write = (line) => notes.write({ title: TITLE, text: notes.find(TITLE) ? line : `${INTRO}\n\n${line}` });
  const asked = new Set();
  let asking = false;

  function names() {
    const out = [];
    for (const t of notes.titles()) {
      const m = /^(.+?) (?:project|brief|\(pinned chat\))$/i.exec(t);
      if (m) out.push(m[1].trim());
    }
    for (const p of rt.projects?.list?.() || []) out.push(p.name);
    return out.filter((n) => n && !isContainerName(n));
  }

  function set(a, b, isSame) {
    const line = isSame ? addSame(read(), [a, b]) : `- ${a} ≠ ${b}`;
    if (line) write(line);
    return { note: isSame ? `Okay, ${a} and ${b} are one thing now.` : `Okay, ${a} and ${b} stay separate.` };
  }

  async function check() {
    const { merge, ask } = findGroups(names(), parseSame(read()));
    const joined = [];
    for (const g of merge) {
      const line = addSame(read(), g.names);
      if (!line) continue;
      write(line);
      joined.push(`${g.names.filter((n) => n !== g.main).join(', ')} → ${g.main}`);
    }
    if (joined.length) rt.say?.(`I joined names that are the same thing: ${joined.join('; ')}. Say "X and Y are different" if I got one wrong.`, { kind: null });
    const pair = asking ? null : ask.find(([a, b]) => !asked.has(`${lower(a)}\n${lower(b)}`));
    if (pair && rt.ask) {
      const [a, b] = pair;
      asked.add(`${lower(a)}\n${lower(b)}`);
      asking = true;
      const q = `Are ${a} and ${b} the same thing?`;
      rt.ask({ title: q, prompt: q, detail: 'Yes joins them into one dot in Novi Memory (and one name for Novi). No keeps them apart.', source: 'wiki' })
        .then((d) => { if (d?.allow === true) set(a, b, true); else if (d?.allow === false) set(a, b, false); })
        .catch((err) => log(`[same] ${err.message}`))
        .finally(() => { asking = false; });
    }
    return { joined: joined.length, asked: pair ? 1 : 0 };
  }

  // Other names for the same thing ("medikiosk" → ["medikiiosk", "MediKiosk AI"]).
  const aliasesOf = (name) => {
    const g = parseSame(read()).groups.find((x) => x.some((n) => lower(n) === lower(name)));
    return g ? g.filter((n) => lower(n) !== lower(name)) : [];
  };
  return { check, set, aliasesOf, names };
}
