import { describe, it, expect } from 'vitest';
import { previewCommand, openCommand } from '../../server/brain/previewCommand.js';

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

  // The user (2026-10-17): "open portfolio" opened a file. Open X = the project's website; "in VS Code"
  // = that editor; a file or folder only when they say "file" / "folder".
  it('"open portfolio" → the site; "open portfolio in VS Code / antigravity" → that editor', () => {
    expect(openCommand('open portfolio')).toEqual({ tool: 'preview_open', args: { project: 'portfolio' } });
    expect(openCommand('Open my portfolio website.')).toEqual({ tool: 'preview_open', args: { project: 'portfolio' } });
    expect(openCommand('open the portfolio project in the browser')).toEqual({ tool: 'preview_open', args: { project: 'portfolio' } });
    expect(openCommand('open portfolio in VS Code')).toEqual({ tool: 'open_project', args: { project: 'portfolio', editor: 'vs code' } });
    expect(openCommand('open the project portfolio in antigravity')).toEqual({ tool: 'open_project', args: { project: 'portfolio', editor: 'antigravity' } });
    expect(openCommand('open my portfolio folder')).toBeNull();
    expect(openCommand('open the portfolio file')).toBeNull();
    expect(openCommand('open portfolio and add a dark mode')).toBeNull();
  });

  // Live (2026-10-17): this sent a laptop screenshot; it means the project the coder is working on.
  it('"a screenshot of the work you are doing" is the project\'s site', () => {
    for (const t of ["Send me the screenshot of the work you're doing right now.", 'show me what you are building', 'send me a picture of your progress', 'show me the work so far', 'kaam ka screenshot bhejo'])
      expect(previewCommand(t), t).toEqual({ tool: 'preview_show', args: { page: 'home' } });
    expect(previewCommand('take a screenshot of my laptop')).toBeNull();
    expect(previewCommand('what are you doing')).toBeNull();
  });

  it('stop the preview', () => {
    for (const t of ['stop the preview', 'close the preview', 'preview band karo']) expect(previewCommand(t), t).toEqual({ tool: 'preview_stop', args: {} });
  });
  it('other things stay where they are', () => {
    for (const t of ['show me the HTML', 'show me valorant', 'open the login page', 'show me my GitHub graph', 'show me the code', 'show me the leetcode login page', 'show me the youtube home page']) expect(previewCommand(t), t).toBe(null);
  });
});

// Live 2026-10-18: "screenshot of the blog section" — a section counts like a page.
describe('sections', () => {
  it('"blog section" / "the blog part" / "show me the blog section" → that page or section', () => {
    expect(previewCommand('send me a screenshot of the blog section')).toEqual({ tool: 'preview_show', args: { page: 'blog' } });
    expect(previewCommand('show me the blog section of portfolio')).toEqual({ tool: 'preview_show', args: { page: 'blog', project: 'portfolio' } });
    expect(previewCommand('ss of the projects part')).toEqual({ tool: 'preview_show', args: { page: 'projects' } });
  });
});
