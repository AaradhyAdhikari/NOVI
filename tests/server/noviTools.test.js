import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNoviTools } from '../../server/tools/noviTools.js';
import { Memory } from '../../server/memory.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tools-'));
  const memory = new Memory(path.join(dir, 'm.json'));
  const calls = [];
  const tasks = {
    start: (p, i) => { calls.push(['start', p, i]); return { active: true, project: p, status: 'running' }; },
    send: (t) => { calls.push(['send', t]); return { active: true, status: 'running' }; },
    status: () => ({ active: false }),
    stop: async () => true,
    setAllowEdits: (v) => calls.push(['allowEdits', v]),
  };
  return { dir, memory, tasks, calls, tools: createNoviTools({ memory, tasks }) };
}

describe('createNoviTools', () => {
  it('exposes OpenAI-format schemas for all tools', () => {
    const { tools } = setup();
    const names = tools.schemas().map((s) => s.function.name);
    expect(names).toEqual(['list_projects', 'remember_project', 'forget_project', 'code_start_task', 'code_send_message', 'code_status', 'code_stop', 'code_allow_edits']);
    for (const s of tools.schemas()) {
      expect(s.type).toBe('function');
      expect(s.function.parameters.type).toBe('object');
    }
  });

  it('assigns tiers', () => {
    const { tools } = setup();
    expect(tools.get('list_projects').tier).toBe('low');
    expect(tools.get('code_start_task').tier).toBe('medium');
    expect(tools.get('remember_project').tier).toBe('medium');
    expect(tools.get('code_stop').tier).toBe('low');
  });

  it('remembers and lists projects', async () => {
    const { tools, dir } = setup();
    await tools.get('remember_project').run({ name: 'Site', path: dir });
    expect(await tools.get('list_projects').run({})).toEqual({ projects: [{ name: 'site', path: path.resolve(dir) }] });
  });

  it('starts tasks and sends follow-ups through the task manager', async () => {
    const { tools, calls } = setup();
    const out = await tools.get('code_start_task').run({ project: 'site', instruction: 'add login' });
    expect(out.started).toBe(true);
    await tools.get('code_send_message').run({ instruction: 'fix it' });
    expect(calls).toEqual([['start', 'site', 'add login'], ['send', 'fix it']]);
  });

  it('describes actions for approval prompts', () => {
    const { tools } = setup();
    expect(tools.get('code_start_task').describe({ project: 'site', instruction: 'add login' })).toBe('Start Novi Coder (free, Groq) on site: "add login"');
  });
});

describe('choosing the coder by voice', () => {
  function withCoder(coder) {
    const s = setup();
    const started = [];
    s.tasks.start = (p, i, opts) => { started.push(opts); return { active: true }; };
    return { ...s, started, tools: createNoviTools({ memory: s.memory, tasks: s.tasks, coder, alternativeAvailable: true }) };
  }

  it('the brain can pick the coder the user named; otherwise the default (Claude Code) is used', async () => {
    const { tools, started } = withCoder('claude');
    const start = tools.get('code_start_task');
    expect(start.parameters.properties.agent.enum).toEqual(['claude', 'novi-coder']);
    await start.run({ project: 'site', instruction: 'add login' });
    await start.run({ project: 'site', instruction: 'add login', agent: 'novi-coder' });
    await start.run({ project: 'site', instruction: 'add login', agent: 'cursor' }); // not a coder → default
    expect(started.map((o) => o?.agent)).toEqual([undefined, 'novi-coder', undefined]);
  });

  it('the spoken question names the coder that will run, and a card choice still wins', async () => {
    const { tools, started } = withCoder('claude');
    const start = tools.get('code_start_task');
    expect(start.prompt({ project: 'site', instruction: 'add login' })).toMatch(/^I'll use Claude Code/);
    expect(start.prompt({ project: 'site', instruction: 'add login', agent: 'novi-coder' })).toMatch(/^I'll use Novi Coder.*use Claude instead/);
    expect(start.describe({ project: 'site', instruction: 'x', agent: 'novi-coder' })).toMatch(/^Start Novi Coder/);
    expect(start.choices({ project: 'site', instruction: 'x', agent: 'novi-coder' })[0]).toMatchObject({ id: 'claude', params: { $agent: 'claude' } });
    await start.run({ project: 'site', instruction: 'x', agent: 'novi-coder', $agent: 'claude' });
    expect(started.at(-1).agent).toBe('claude');
  });
});

describe('Novi picks the coder by how hard the job is', () => {
  it('tells the brain: small edits → Novi Coder (free), bigger work → Claude Code, what the user says wins', () => {
    const s = setup();
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, coder: 'claude', alternativeAvailable: true });
    const agent = tools.get('code_start_task').parameters.properties.agent.description;
    expect(agent).toMatch(/named/i);
    expect(agent).toMatch(/novi-coder.*small|small.*novi-coder/i);
    expect(agent).toMatch(/claude.*(bigger|feature|bug)/i);
  });

  it('without Claude Code installed there is nothing to choose between', () => {
    const s = setup();
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, coder: 'novi-coder', alternativeAvailable: false });
    expect(tools.get('code_start_task').parameters.properties.agent).toBeUndefined();
  });
});

describe('code_take_over', () => {
  it('hands the task over to interactive Claude Code on the laptop', async () => {
    const s = setup();
    const opened = [];
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, takeOver: async () => { opened.push('x'); return { project: 'novi' }; } });
    const t = tools.get('code_take_over');
    expect(t.tier).toBe('low');
    expect(t.description).toMatch(/take over/i);
    expect(await t.run({})).toEqual({ tookOver: true, project: 'novi', note: 'Opened Claude Code on novi with the same conversation. Over to you.' });
    expect(opened).toEqual(['x']);
  });

  it('is only offered when the laptop can open Claude Code', () => {
    const s = setup();
    expect(createNoviTools({ memory: s.memory, tasks: s.tasks }).get('code_take_over')).toBeFalsy();
  });
});

describe('code_new_project (new project from the phone, built by Claude Code)', () => {
  const newSetup = () => {
    const s = setup();
    const projectsDir = path.join(s.dir, 'Projects');
    const started = [];
    s.tasks.start = (p, i, o) => { started.push([p, i, o]); return { active: true, project: p, status: 'running' }; };
    return { ...s, projectsDir, started, tools: createNoviTools({ memory: s.memory, tasks: s.tasks, coder: 'claude', alternativeAvailable: true, projectsDir }) };
  };

  it('makes the folder with a README (name + description), remembers it, and starts the coder on the prompt', async () => {
    const { tools, memory, projectsDir, started } = newSetup();
    const tool = tools.get('code_new_project');
    expect(tool.tier).toBe('medium');
    const args = { name: 'Sample Project', description: 'A to-do app for my college work', instruction: 'Build a React to-do app with dark mode' };
    expect(tool.prompt(args)).toMatch(/new project "Sample Project".*Claude Code.*Build a React to-do app with dark mode/s);
    const out = await tool.run(args);
    const folder = path.join(projectsDir, 'Sample Project');
    expect(fs.readFileSync(path.join(folder, 'README.md'), 'utf8')).toBe('# Sample Project\n\nA to-do app for my college work\n');
    expect(memory.findProject('sample project').path).toBe(folder);
    expect(started).toEqual([['sample project', 'Build a React to-do app with dark mode\n\nThis is a new, empty project called "Sample Project": A to-do app for my college work. Start from scratch in this folder.', { agent: undefined }]]);
    expect(out).toMatchObject({ created: folder, started: true });
  });

  it('a brand-new folder has nothing to lose: file edits there don\'t ask each time (commands still do), and the yes/no says so', async () => {
    const { tools, calls } = newSetup();
    const args = { name: 'Fresh', instruction: 'Build a landing page' };
    expect(tools.get('code_new_project').prompt(args)).toMatch(/won't ask before each file edit/);
    await tools.get('code_new_project').run(args);
    expect(calls).toContainEqual(['allowEdits', true]);
  });

  it('finds Documents\\Projects (OneDrive first)', async () => {
    const { defaultProjectsDir } = await import('../../server/tools/noviTools.js');
    const home = path.join('H');
    expect(defaultProjectsDir(home, (d) => d === path.join(home, 'OneDrive', 'ドキュメント'))).toBe(path.join(home, 'OneDrive', 'ドキュメント', 'Projects'));
    expect(defaultProjectsDir(home, () => false)).toBe(path.join(home, 'Documents', 'Projects'));
  });

  it('works without a prompt or description, keeps names safe for Windows, and never overwrites a project', async () => {
    const { tools, projectsDir, started } = newSetup();
    const out = await tools.get('code_new_project').run({ name: 'My: App?' });
    expect(out.created).toBe(path.join(projectsDir, 'My App'));
    expect(started).toEqual([]);
    fs.writeFileSync(path.join(projectsDir, 'My App', 'index.js'), 'x');
    await expect(tools.get('code_new_project').run({ name: 'My App' })).rejects.toThrow(/already exists/);
    await expect(tools.get('code_new_project').run({ name: ' ../ ' })).rejects.toThrow(/name/);
  });

  it('is only offered when Novi knows where projects live', () => {
    expect(setup().tools.get('code_new_project')).toBeFalsy();
  });
});

describe('code_show ("show me the html code")', () => {
  it('finds the code in the current task\'s project and sends it as a picture', async () => {
    const s = setup();
    const folder = path.join(s.dir, 'site');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'index.html'), '<html>\n<button>Go</button>\n</html>\n');
    s.memory.rememberProject('site', folder);
    s.tasks.status = () => ({ active: true, project: 'site', path: folder, files: [path.join(folder, 'index.html')] });
    const shown = [];
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, showImage: (img) => shown.push(img) });
    const tool = tools.get('code_show');
    expect(tool.tier).toBe('low');
    const out = await tool.run({ what: 'the html code' });
    expect(out).toMatchObject({ file: 'index.html', lines: '1–4' });
    expect(shown[0].svg).toContain('&lt;button&gt;Go&lt;/button&gt;');
    expect(shown[0].caption).toBe('site · index.html · lines 1–4');
    await expect(tool.run({ what: 'the rust code' })).rejects.toThrow(/couldn't find/);
  });

  it('asks which project when there is no task', async () => {
    const s = setup();
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, showImage: () => {} });
    await expect(tools.get('code_show').run({ what: 'html' })).rejects.toThrow(/Which project/);
  });
});

describe('changes while the coder works ("make the button blue", "add dark mode")', () => {
  it('asks a spoken yes / no / cancel first, then sends the change to the same task', async () => {
    const s = setup();
    const tool = s.tools.get('code_send_message');
    expect(tool.tier).toBe('medium');
    expect(tool.prompt({ instruction: 'make the button blue' })).toBe("I'll tell Novi Coder: make the button blue. Okay? Say yes, no or cancel.");
    expect(tool.description).toMatch(/dark mode/);
    s.tasks.status = () => ({ active: true, status: 'running', agent: 'Claude' });
    expect(tool.prompt({ instruction: 'add dark mode' })).toBe("I'll tell Claude: add dark mode. Okay? Say yes, no or cancel.");
    const out = await tool.run({ instruction: 'make the button blue' });
    expect(s.calls).toContainEqual(['send', 'make the button blue']);
    expect(out.note).toMatch(/after/);
  });
});
