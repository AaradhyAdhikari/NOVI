// "Make me a diagram of X" without the AI (plugins/diagram): "show me the system diagram of my tip
// calculator project", "give me the architecture diagram for tracebites", "flexr ka diagram banao",
// "diagram of facebook/react", or a GitHub link. A name GitHub doesn't know goes on to the AI (agent.js).
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|please|so|now)[,\s]+|novi,\s*)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const ASK = '(?:(?:make|show|give|create|draw|generate|get|open|send|build)(?:\\s+me)?\\s+)?';
const KIND = '(?:(?:a|an|the|my)\\s+)?(?:(?:system|architecture|project|code|app)\\s+)?diagram';
const REPO = /github\.com|gitdiagram\.com|^[\w.-]+\/[\w.-]+$/i;
const THIS = /^(?:this|it|the|my|current)?\s*(?:project|repo(?:sitory)?|app|code)?$/i;

const clean = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:project|repo(?:sitory)?|app|code(?:base)?)$/i, '').replace(/'s$/i, '').trim();

function args(said) {
  const t = String(said || '').trim();
  if (THIS.test(t)) return { tool: 'project_diagram', args: {} };
  if (REPO.test(t)) return { tool: 'project_diagram', args: { repo: t } };
  return { tool: 'project_diagram', args: { project: clean(t) } };
}

const PHONE = /\s+(?:(?:to|on)\s+(?:my\s+|the\s+)?phone|phone\s+(?:pe|par)(?=\s|$))/i;

function parse(t) {
  let m;
  if ((m = new RegExp(`^${ASK}${KIND}(?:\\s+(?:of|for)\\s+(.+))?$`, 'i').exec(t))) {
    // A bare "diagram" needs an asking word or a name, so "the diagram" alone stays with the AI.
    return m[1] || /^(?:make|show|give|create|draw|generate|get|open|send|build)/i.test(t) ? args(m[1]) : null;
  }
  if ((m = /^(.+?)\s+ka\s+(?:system\s+|architecture\s+)?diagram(?:\s+(?:banao|bana do|dikhao|do|bhejo))?$/i.exec(t))) return args(m[1]);
  return null;
}

export function diagramCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  const out = parse(t.replace(PHONE, '').trim());
  return out && PHONE.test(t) ? { ...out, args: { ...out.args, phone: true } } : out;
}
