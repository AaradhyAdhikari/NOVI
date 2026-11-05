import { describe, it, expect } from 'vitest';
import { plainTool, isReadOnlyTool } from '../../server/claude/toolNames.js';
import { classifyClaudeTool } from '../../server/permissions.js';
import { claudeAsk } from '../../server/claude/taskManager.js';

// Live 2026-11-05: "Claude wants to use mcp__rea__capture_browser_scenario": "whats this", and three cards
// in a row just for Claude searching its own memory.
const MEM = 'mcp__plugin_claude-mem_mcp-search__';
const GMAIL = 'mcp__ebf0f015-3ceb-48b2-9ea3-b5ff684334a0__';

describe('tools that only look', () => {
  it('Claude searching its memory or code never asks', () => {
    for (const t of ['search', 'smart_search', 'timeline', 'get_observations']) expect(isReadOnlyTool(`${MEM}${t}`)).toBe(true);
    expect(isReadOnlyTool('mcp__rea__read_bytes')).toBe(true);
    expect(classifyClaudeTool(`${MEM}search`, {}, 'C:\\p')).toBe('low');
  });
  it('anything that changes something still asks, whatever it starts with', () => {
    for (const t of ['save_memory', 'work_state_write', 'get_or_create_drive', 'list_and_delete', 'run_session_command']) expect(isReadOnlyTool(`mcp__rea__${t}`)).toBe(false);
    expect(isReadOnlyTool('mcp__rea__capture_browser_scenario')).toBe(false);
  });
  it('your accounts and open browser pages still ask, even just to read', () => {
    expect(isReadOnlyTool(`${GMAIL}search_threads`)).toBe(false);
    expect(isReadOnlyTool('mcp__claude-in-chrome__read_page')).toBe(false);
    expect(isReadOnlyTool('mcp__Claude_Browser__get_page_text')).toBe(false);
    expect(isReadOnlyTool('mcp__terminal__read_terminal')).toBe(false);
    expect(isReadOnlyTool('mcp__plugin_desktop-commander_desktop-commander__read_file')).toBe(false);
  });
  it('only tools from outside count here', () => {
    expect(isReadOnlyTool('Skill')).toBe(false);
    expect(isReadOnlyTool('')).toBe(false);
  });
});

describe('cards in plain words', () => {
  it('says what the tool does', () => {
    expect(plainTool('mcp__rea__capture_browser_scenario')).toBe('test a page in a browser');
    expect(plainTool(`${GMAIL}send_message`)).toBe('send a message using a connected app');
    expect(plainTool(`${GMAIL}trash_thread`)).toBe('delete something using a connected app');
    expect(plainTool('mcp__rea__start_frida_session')).toBe('start something using rea');
  });
  it('a tool it has no words for still reads as words', () => {
    expect(plainTool('mcp__rea__decompile_all')).toBe('use "decompile all" from rea');
    expect(plainTool(`${MEM}build_corpus`)).toBe('use "build corpus" from claude-mem');
  });
  it('the exact tool and what it was given stay in the details', () => {
    const c = claudeAsk('mcp__rea__capture_browser_scenario', { url: 'http://localhost:5173' });
    expect(c.title).toBe('Claude wants to test a page in a browser');
    expect(c.prompt).toBe('Claude wants to test a page in a browser.');
    expect(c.detail).toContain('mcp__rea__capture_browser_scenario');
    expect(c.detail).toContain('localhost:5173');
  });
  it("Claude Code's own tools too", () => {
    expect(claudeAsk('WebFetch', { url: 'https://a.dev' }).title).toBe('Claude wants to read a web page');
    expect(claudeAsk('Agent', {}).title).toBe('Claude wants to start a helper');
    expect(claudeAsk('Skill', { skill: 'pdf' }).title).toBe('Claude wants to use the pdf skill');
  });
});
