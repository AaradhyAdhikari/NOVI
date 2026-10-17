import { describe, it, expect } from 'vitest';
import { previewCommand } from '../../server/brain/previewCommand.js';

const show = (args) => ({ tool: 'preview_show', args });
describe('preview by voice (no AI)', () => {
  it('pages, the site, a named project, Hinglish', () => {
    expect(previewCommand('show me the homepage')).toEqual(show({ page: 'home' }));
    expect(previewCommand('Show me the home page.')).toEqual(show({ page: 'home' }));
    expect(previewCommand('show me the contact page')).toEqual(show({ page: 'contact' }));
    expect(previewCommand('show the about page')).toEqual(show({ page: 'about' }));
    expect(previewCommand('show me the site')).toEqual(show({ page: 'home' }));
    expect(previewCommand('show me the website')).toEqual(show({ page: 'home' }));
    expect(previewCommand('show me the homepage of portfolio')).toEqual(show({ page: 'home', project: 'portfolio' }));
    expect(previewCommand('show me the contact page of my portfolio')).toEqual(show({ page: 'contact', project: 'portfolio' }));
    expect(previewCommand('homepage dikhao')).toEqual(show({ page: 'home' }));
    expect(previewCommand('preview dikhao')).toEqual(show({ page: 'home' }));
    expect(previewCommand('contact page dikhao')).toEqual(show({ page: 'contact' }));
    expect(previewCommand('show me the preview')).toEqual(show({ page: 'home' }));
  });
  // Live (2026-10-17): this went to the AI, which also sent a laptop screenshot and called it the site.
  it('"screenshot / picture of the homepage (of the portfolio)" is the preview too', () => {
    expect(previewCommand('I meant the portfolio screenshot, the homepage of the portfolio.')).toEqual({ tool: 'preview_show', args: { page: 'home' } });
    expect(previewCommand('send me a screenshot of the contact page')).toEqual({ tool: 'preview_show', args: { page: 'contact' } });
    expect(previewCommand('ss of the homepage')).toEqual({ tool: 'preview_show', args: { page: 'home' } });
    expect(previewCommand('take a screenshot of my laptop')).toBeNull();
    expect(previewCommand('screenshot of the github homepage')).toBeNull();
  });

  it('stop the preview', () => {
    for (const t of ['stop the preview', 'close the preview', 'preview band karo']) expect(previewCommand(t), t).toEqual({ tool: 'preview_stop', args: {} });
  });
  it('other things stay where they are', () => {
    for (const t of ['show me the HTML', 'show me valorant', 'open the login page', 'show me my GitHub graph', 'show me the code', 'show me the leetcode login page', 'show me the youtube home page']) expect(previewCommand(t), t).toBe(null);
  });
});
