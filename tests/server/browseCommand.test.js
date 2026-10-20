import { describe, it, expect } from 'vitest';
import { browseCommand } from '../../server/brain/browseCommand.js';

// "Browse X" without the AI (user, 2026-10-20: "a browser dot so it doesn't use any AI"). Live, the AI
// route took 21–25 s to open a website; this opens it at once.
describe('browseCommand', () => {
  it('"browse X": a domain, a known site, or a Google search', () => {
    expect(browseCommand('browse github.com')).toEqual({ target: 'https://github.com' });
    expect(browseCommand('Browse to leetcode.com/problemset.')).toEqual({ target: 'https://leetcode.com/problemset' });
    expect(browseCommand('browse youtube')).toEqual({ target: 'https://www.youtube.com' });
    expect(browseCommand('browse best laptops under 60000')).toEqual({ target: 'best laptops under 60000' });
    expect(browseCommand('okay Novi, browse https://example.org/a?b=1 please')).toEqual({ target: 'https://example.org/a?b=1' });
  });

  it('"open/go to/visit X website", "X.com", Hinglish', () => {
    expect(browseCommand('open the GitHub website')).toEqual({ target: 'https://github.com' });
    expect(browseCommand('open chatgpt.com')).toEqual({ target: 'https://chatgpt.com' });
    expect(browseCommand('go to amazon.in')).toEqual({ target: 'https://amazon.in' });
    expect(browseCommand('visit wikipedia')).toEqual({ target: 'https://www.wikipedia.org' });
    expect(browseCommand('flipkart website kholo')).toEqual({ target: 'https://www.flipkart.com' });
    expect(browseCommand('linkedin.com khol do')).toEqual({ target: 'https://linkedin.com' });
  });

  it('on my laptop / on my phone', () => {
    expect(browseCommand('browse github.com on my laptop')).toEqual({ target: 'https://github.com', on: 'laptop' });
    expect(browseCommand('open youtube website laptop pe')).toEqual({ target: 'https://www.youtube.com', on: 'laptop' });
  });

  it('"browse this / it": the last link', () => {
    expect(browseCommand('browse this')).toEqual({ last: true });
    expect(browseCommand('open it in the browser')).toEqual({ last: true });
  });

  it('leaves everything else to the other routes and the AI', () => {
    for (const t of ['open spotify', 'open notepad', 'go to chrome', 'open my notes', 'open portfolio', 'browse my files',
      'open the downloads folder', 'play lofi on youtube', 'what is github', 'open youtube and play lofi', 'search the web for news']) {
      expect(browseCommand(t), t).toBe(null);
    }
  });
});
