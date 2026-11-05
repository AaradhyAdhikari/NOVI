// Claude's tools in plain words, and which ones only look (user, 2026-11-05: "whats this" about a card that
// said "mcp__rea__capture_browser_scenario", and three cards for Claude searching its own memory).
const parse = (name) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? { server: m[1], tool: m[2] } : null;
};
const words = (tool) => tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Servers named by an id are the user's connected accounts (mail, Drive, calendar…). Those, and whatever is
// on the user's screen or in their browser, keep asking even to read: private things stay the user's call.
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const PRIVATE_SERVER = /browser|chrome|computer-use|terminal|desktop-commander|ccd_/i;
const LOOKS = new Set(['get', 'list', 'read', 'search', 'find', 'query', 'lookup', 'inspect', 'describe', 'timeline', 'smart', 'dumb']);
const CHANGES = /^(add|apply|build|buy|cancel|change|clear|close|create|delete|deploy|edit|exec|execute|forward|install|kill|launch|load|mark|move|open|post|pull|push|put|remove|rename|reply|run|save|send|set|share|start|stop|trash|uninstall|update|upload|write)$/;

export function isReadOnlyTool(name) {
  const m = parse(name);
  if (!m || ACCOUNT.test(m.server) || PRIVATE_SERVER.test(m.server)) return false;
  const w = words(m.tool);
  return LOOKS.has(w[0]) && !w.some((x) => CHANGES.test(x));
}

function serverLabel(server) {
  if (ACCOUNT.test(server)) return 'a connected app';
  return server.replace(/^plugin_/, '').split('_')[0];
}

// Checked in order: a tool that deletes must never read as something milder.
const ACTIONS = [
  [/delete|trash|remove|uninstall|clear|kill/, 'delete something'],
  [/send|reply|forward|post|publish/, 'send a message'],
  [/deploy|promote|rollback/, 'deploy the project'],
  [/buy|purchase|payment/, 'buy something'],
  [/install/, 'install something'],
  [/upload|share/, 'share a file'],
  [/create|new|add/, 'create something'],
  [/update|edit|write|save|set|rename|change/, 'change something'],
  [/start|run|exec|launch/, 'start something'],
];

export function plainTool(name) {
  const m = parse(name);
  if (!m) return null;
  const tool = m.tool.toLowerCase();
  if (/browser|web_page|web_screenshot/.test(tool)) return 'test a page in a browser';
  if (/screenshot|capture_.*screen/.test(tool)) return 'take a screenshot';
  const from = serverLabel(m.server);
  const action = ACTIONS.find(([re]) => words(tool).some((w) => re.test(w)));
  return action ? `${action[1]} using ${from}` : `use "${words(tool).join(' ')}" from ${from}`;
}

// Claude Code's own tools that can reach a card.
export function plainBuiltin(toolName, input = {}) {
  if (toolName === 'WebFetch') return 'read a web page';
  if (toolName === 'Agent' || toolName === 'Task') return 'start a helper';
  if (toolName === 'Skill' && input.skill) return `use the ${input.skill} skill`;
  return null;
}
