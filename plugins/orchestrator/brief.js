// The brief, put together without AI from the sites' answers: fixed sections, each naming its
// source, and a short line to say aloud.
const pattern = (h) => h.split(/\s+/).map((w) => (w === '&' ? '(?:&|and)' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\s+');
const headingRe = (h) => new RegExp(`^\\s*(?:#{1,6}\\s*)?[*_]*\\s*${pattern(h)}\\s*[*_]*\\s*(?::\\s*[*_]*\\s*(.*)|$)`, 'i');

// { heading: text } for the headings found in an answer, however the site wrote them
// ("## Steps", "**Goal:** …", "Security Rules:"). No headings at all → everything under the first.
export function sections(text, headings) {
  const out = {};
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const hit = headings.find((h) => headingRe(h).test(line));
    if (hit) {
      current = hit;
      const inline = headingRe(hit).exec(line)[1];
      out[current] = inline ? [inline] : [];
    } else if (current) out[current].push(line);
  }
  const done = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
  return Object.keys(done).length ? done : { [headings[0]]: String(text || '').trim() };
}

// Numbered or bulleted lines; a page's own list ("1." drawn by the page, live 2026-10-20) arrives
// without markers, so then every non-empty line is one item.
const items = (s) => {
  const lines = String(s || '').split('\n').filter((l) => l.trim());
  const marked = lines.filter((l) => /^\s*(?:\d+[.)]|[-*•])\s+/.test(l)).length;
  return marked || lines.length;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// plan / ideas: { text, source, why? } (why = what failed before a backup answered) or { error }.
export function buildBrief({ project, request, plan = {}, ideas = {} }) {
  const p = plan.text ? sections(plan.text, ['Goal', 'Steps', 'Look & feel', 'Done when']) : {};
  const i = ideas.text ? sections(ideas.text, ['Examples', 'Security rules']) : {};
  const part = (name, from, src) => (from.text
    ? `## ${name} (${from.source})\n${src[name] || '(not given)'}`
    : `## ${name}\n(missing: ${from.error || 'no answer'})`);
  const notes = [plan.why && `${plan.why} ${cap(plan.source)} wrote the plan.`, ideas.why && `${ideas.why} ${cap(ideas.source)} wrote the examples and security rules.`].filter(Boolean);
  const text = [
    `# Brief: ${project}\nWhat you asked: ${request}${notes.length ? `\n${notes.join(' ')}` : ''}`,
    part('Goal', plan, p), part('Steps', plan, p), part('Look & feel', plan, p),
    part('Examples', ideas, i), part('Security rules', ideas, i), part('Done when', plan, p),
  ].join('\n\n');
  const steps = items(p.Steps);
  const examples = items(i.Examples);
  const rules = items(i['Security rules']);
  const said = [];
  if (plan.text) said.push(`${cap(plan.source)} planned ${steps} step${steps === 1 ? '' : 's'}`);
  if (ideas.text) said.push(`${plan.text ? ideas.source : cap(ideas.source)} found ${examples} example${examples === 1 ? '' : 's'} and ${rules} security rule${rules === 1 ? '' : 's'}`);
  let spoken = said.join(' and ');
  if (!plan.text) spoken = `I couldn't get a plan.${spoken ? ` ${spoken}.` : ''}`;
  else spoken += '.';
  if (!ideas.text) spoken += " I couldn't get examples or security rules.";
  return { text, spoken: `${spoken} Send it to Claude?`, steps, examples, rules };
}
