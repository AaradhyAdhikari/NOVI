import { describe, it, expect } from 'vitest';
import { briefCommand, changeCommand } from '../../server/brain/briefCommand.js';

// Big jobs where Claude isn't named get a brief first (user, 2026-10-18).
describe('briefCommand', () => {
  it('"let\'s work on X": a project, the whole sentence as the request', () => {
    expect(briefCommand("Let's work on portfolio today and add a blog.")).toEqual({ project: 'portfolio', request: "Let's work on portfolio today and add a blog" });
    expect(briefCommand('okay lets work on my novi project')).toEqual({ project: 'novi', request: 'okay lets work on my novi project' });
    expect(briefCommand("let's continue with the calculator app")).toEqual({ project: 'calculator', request: "let's continue with the calculator app" });
  });

  it('new things to build: a new project, its name when said', () => {
    expect(briefCommand('make a new project called recipe box for saving recipes')).toEqual({ isNew: true, name: 'recipe box', request: 'make a new project called recipe box for saving recipes' });
    expect(briefCommand("let's build a todo app with dark mode")).toEqual({ isNew: true, request: "let's build a todo app with dark mode" });
    expect(briefCommand('build me a website for my cafe')).toEqual({ isNew: true, request: 'build me a website for my cafe' });
    expect(briefCommand('create a new app')).toEqual({ isNew: true, request: 'create a new app' });
  });

  it('never: Claude named, "skip the brief", small things, folders and other non-project things', () => {
    for (const t of ["let's work on portfolio, tell Claude to add a blog", 'Claude, build me a website', "let's build a todo app, skip the brief", 'make the button blue',
      "let's make a folder called test", "let's play some music", 'build me a playlist', 'make a reminder for 5 pm', "let's start a timer"]) expect(briefCommand(t), t).toBeNull();
  });
});

describe('changeCommand (only used while a brief card waits)', () => {
  it('"change X", "instead X", "X instead"', () => {
    expect(changeCommand('Change it to a blue theme.')).toBe('a blue theme');
    expect(changeCommand('no, change the plan so that it uses Next.js')).toBe('it uses Next.js');
    expect(changeCommand('instead, use plain HTML')).toBe('use plain HTML');
    expect(changeCommand('use plain HTML instead')).toBe('use plain HTML');
    expect(changeCommand('yes')).toBeNull();
    expect(changeCommand('change')).toBeNull();
  });
});
