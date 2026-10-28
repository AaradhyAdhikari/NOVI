// What the done-check says, shows and sends Claude. Four states: passed, failed, uncertain (tried,
// couldn't tell), not checked (needs the user).
const bare = (s) => String(s || '').trim().replace(/[.!?]+$/, '');
// Spoken names stay short (live: the whole Look & feel paragraph was read out); the chat list has it all.
function short(text) {
  if (/^Looks like the brief:/i.test(text)) return 'the look from the brief';
  const words = bare(text).split(/\s+/);
  return words.length > 10 ? `${words.slice(0, 10).join(' ')}…` : words.join(' ');
}
const list = (rs) => rs.map((r) => short(r.text)).join('; ');

export function summary(results) {
  const passed = results.filter((r) => r.state === 'passed').length;
  const failed = results.filter((r) => r.state === 'failed');
  const unsure = results.filter((r) => r.state === 'uncertain');
  const manual = results.filter((r) => r.state === 'not checked');
  const out = [`${passed} of ${results.length} checks passed.`];
  if (failed.length) out.push(`Failed: ${list(failed)}.`);
  if (unsure.length) out.push(`Not sure: ${list(unsure)}.`);
  if (manual.length) out.push(`Not checked: ${list(manual)} — try it yourself.`);
  return out.join(' ');
}

const MARK = { passed: '✓', failed: '✗', uncertain: '?', 'not checked': '–' };

export function resultLines(results) {
  return results.map((r) => `${MARK[r.state] || '?'} ${r.text}${r.state === 'passed' ? '' : ` — ${r.why}`}`);
}

// Only what failed or couldn't be told, each with why and its screenshot. null = nothing to fix.
export function fixMessage(results) {
  const todo = results.filter((r) => r.state === 'failed' || r.state === 'uncertain');
  if (!todo.length) return null;
  const lines = todo.map((r) => `- ${r.text} (${r.state === 'failed' ? 'failed' : 'not sure'}: ${r.why}${r.shot ? ` Screenshot: ${r.shot}` : ''})`);
  return [
    "Novi checked the site against the brief's \"Done when\" list. Fix only these, and don't change anything else:",
    ...lines,
    'Novi will check again when you are done.',
  ].join('\n');
}

const MARKER = 'Follow this brief (made by Novi with ChatGPT and Gemini):';

// The brief inside the instruction Novi sent Claude (plugins/orchestrator), without "Also: …".
export function briefFrom(instruction) {
  const s = String(instruction || '');
  const at = s.indexOf(MARKER);
  if (at < 0) return null;
  let brief = s.slice(at + MARKER.length).replace(/^\s+/, '');
  const also = brief.lastIndexOf('\n\nAlso: ');
  if (also >= 0) brief = brief.slice(0, also);
  return brief.trimEnd();
}
