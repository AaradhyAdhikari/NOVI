import { describe, it, expect } from 'vitest';
import { normalizeEvent } from '../../server/claude/stream.js';

describe('normalizeEvent', () => {
  it('maps init', () => {
    expect(normalizeEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' })).toEqual([{ kind: 'init', sessionId: 's1', model: 'm' }]);
  });
  it('ignores other system subtypes and unknown types', () => {
    expect(normalizeEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
    expect(normalizeEvent({ type: 'something_new' })).toEqual([]);
  });
  it('splits assistant content into text and tool_use, dropping thinking and blank text', () => {
    const raw = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '  ' }, { type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } };
    expect(normalizeEvent(raw)).toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }]);
  });
  it('maps tool results with string or block content', () => {
    const raw = { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'boom' }] },
    ] } };
    expect(normalizeEvent(raw)).toEqual([
      { kind: 'tool_result', id: 'a', isError: false, content: 'ok' },
      { kind: 'tool_result', id: 'b', isError: true, content: 'boom' },
    ]);
  });
  it('ignores user messages with plain string content', () => {
    expect(normalizeEvent({ type: 'user', message: { content: 'hello' } })).toEqual([]);
  });
  it('maps results, treating non-success subtypes as errors', () => {
    expect(normalizeEvent({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', num_turns: 2 }))
      .toEqual([{ kind: 'result', isError: false, text: 'done', sessionId: 's', numTurns: 2 }]);
    expect(normalizeEvent({ type: 'result', subtype: 'error_max_turns', is_error: false, session_id: 's' })[0].isError).toBe(true);
  });
});
