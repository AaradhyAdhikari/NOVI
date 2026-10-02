function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  return '';
}

// Converts one Claude Code stream-json line into zero or more normalized events.
export function normalizeEvent(raw) {
  switch (raw?.type) {
    case 'system':
      if (raw.subtype === 'init') return [{ kind: 'init', sessionId: raw.session_id, model: raw.model }];
      if (raw.subtype === 'permission_denied') return [{ kind: 'permission_denied', toolName: raw.tool_name || null }];
      return [];
    case 'assistant':
      return (raw.message?.content || []).flatMap((block) => {
        if (block.type === 'text' && block.text?.trim()) return [{ kind: 'text', text: block.text }];
        if (block.type === 'tool_use') return [{ kind: 'tool_use', id: block.id, name: block.name, input: block.input || {} }];
        return [];
      });
    case 'user': {
      const content = raw.message?.content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((block) =>
        block.type === 'tool_result'
          ? [{ kind: 'tool_result', id: block.tool_use_id, isError: Boolean(block.is_error), content: textOf(block.content).slice(0, 2000) }]
          : [],
      );
    }
    case 'result':
      return [{ kind: 'result', isError: Boolean(raw.is_error) || raw.subtype !== 'success', text: raw.result || '', sessionId: raw.session_id, numTurns: raw.num_turns }];
    case 'rate_limit_event':
      return [{ kind: 'rate_limit', info: raw }];
    default:
      return [];
  }
}
