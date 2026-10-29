import { describe, it, expect } from 'vitest';
import { parseUsage, usageLine } from '../../plugins/claude-link/usage.js';
import { claudeUsageCommand } from '../../server/brain/claudeLinkCommand.js';

// User, 2026-10-29: "show me my Claude usage" got "which stats?" — the numbers live on
// claude.ai/settings/usage; Novi reads them there (its background Chrome tab) and says them.
const PAGE = 'Usage\nHeads up. At this pace you\'ll run out this evening, before the Nov 4 reset.\nCurrent session\n39% used\nResets in 4 hr 14 min\nWeekly limits\nAll models\n58% used\nResets Wed, 3:29 am\nLimit resets\nNo resets right now';

describe('Claude usage from claude.ai', () => {
  it('reads each limit: name, % used, when it resets', () => {
    expect(parseUsage(PAGE)).toEqual([
      { label: 'Current session', used: 39, resets: 'in 4 hr 14 min' },
      { label: 'All models', used: 58, resets: 'Wed, 3:29 am' },
    ]);
    expect(parseUsage('Current session 12% used Resets in 2 hr')).toEqual([{ label: 'Current session', used: 12, resets: 'in 2 hr' }]);
    expect(parseUsage('Log in to Claude')).toEqual([]);
  });

  // The desktop page (live 2026-10-29): a Settings pop-up, "Resets …" BEFORE "% used", "This week".
  it('reads the desktop layout too', () => {
    const DESKTOP = 'Your usage\nPro\nHeads up. At this pace you’ll run out this evening, before the Nov 4 reset.\nBuy usage credits\nCurrent session\nResets at 6:20 AM\n45% used\nThis week\nResets Wednesday 3:30 AM\n59% used\nLimit resets\nNo resets right now';
    const limits = parseUsage(DESKTOP);
    expect(limits).toEqual([
      { label: 'Current session', used: 45, resets: 'at 6:20 AM' },
      { label: 'This week', used: 59, resets: 'Wednesday 3:30 AM' },
    ]);
    expect(usageLine(limits, DESKTOP)).toBe('Claude usage: this session 45% used, resets at 6:20 AM. This week 59% used, resets Wednesday 3:30 AM. Heads up: at this pace you’ll run out this evening, before the Nov 4 reset.');
  });

  it('says it in one short line, with the warning when there is one', () => {
    expect(usageLine(parseUsage(PAGE), PAGE)).toBe("Claude usage: this session 39% used, resets in 4 hr 14 min. All models this week 58% used, resets Wed, 3:29 am. Heads up: at this pace you'll run out this evening, before the Nov 4 reset.");
  });
});

describe('"show me my Claude usage" by voice (no AI)', () => {
  it('takes the ways it is said', () => {
    for (const t of ['Show me my current claude usage', 'claude usage', 'Claude stats', 'how much claude do I have left', 'what is my claude usage', 'usage stats', 'claude limit kitna bacha hai']) {
      expect(claudeUsageCommand(t)).toEqual({ tool: 'claude_usage', args: {} });
    }
  });
  it('leaves other things alone', () => {
    for (const t of ['what is Claude working on', 'disk usage', 'show me my GitHub stats', 'tell Claude to add stats page']) expect(claudeUsageCommand(t)).toBeNull();
  });
});
