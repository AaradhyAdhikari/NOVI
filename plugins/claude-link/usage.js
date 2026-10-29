// Claude usage, read from claude.ai/settings/usage (user, 2026-10-29: "show me my Claude usage" should
// give the numbers): each limit's name, % used and when it resets, said in one short line. No AI.
const USED = /(\d{1,3})\s*%\s*used/i;

export function parseUsage(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  lines.forEach((line, i) => {
    const m = USED.exec(line);
    if (!m) return;
    // Phone app: name, % used, "Resets …". Desktop (a Settings pop-up): name, "Resets …", % used.
    const before = lines[i - 1] || '';
    const resetBefore = /^Resets\b/i.test(before);
    // The name is on the same line before the %, else the line above (above the "Resets" line on desktop).
    let label = line.slice(0, m.index).trim();
    if (!label) label = resetBefore ? lines[i - 2] || '' : before;
    // "Resets …" on the same line after "% used", the line above (desktop), else the next line.
    const after = line.slice(m.index + m[0].length).trim();
    const resetLine = /^Resets\b/i.test(after) ? after : resetBefore ? before : /^Resets\b/i.test(lines[i + 1] || '') ? lines[i + 1] : '';
    out.push({ label: label || 'Usage', used: Number(m[1]), resets: resetLine.replace(/^Resets\s*/i, '').trim() });
  });
  return out;
}

export function usageLine(limits, text = '') {
  if (!limits.length) return null;
  const parts = limits.map((l, i) => {
    const name = i === 0 && /session/i.test(l.label) ? 'this session' : /week/i.test(l.label) ? l.label : `${l.label} this week`;
    return `${i === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1)} ${l.used}% used${l.resets ? `, resets ${l.resets}` : ''}.`;
  });
  const warning = /Heads up\.?\s*([^\n]+)/i.exec(String(text))?.[1]?.trim();
  return `Claude usage: ${parts.join(' ')}${warning ? ` Heads up: ${warning.charAt(0).toLowerCase()}${warning.slice(1)}` : ''}`;
}
