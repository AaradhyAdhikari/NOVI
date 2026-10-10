import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from './registry.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });

const CODERS = {
  'novi-coder': { title: 'Novi Coder (free, Groq)', spoken: 'Novi Coder, free on Groq', other: 'claude', otherLabel: 'Use Claude', otherSpoken: 'use Claude instead' },
  claude: { title: 'Claude Code (your Claude plan)', spoken: 'Claude Code, on your Claude plan', other: 'novi-coder', otherLabel: 'Use Novi Coder', otherSpoken: 'use Novi Coder instead' },
};

// Where "make a new project" puts folders: Documents\Projects (OneDrive's Documents when it exists).
export function defaultProjectsDir(home = os.homedir(), exists = fs.existsSync) {
  const docs = [path.join(home, 'OneDrive', 'ドキュメント'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'Documents')].find((d) => exists(d));
  return path.join(docs || path.join(home, 'Documents'), 'Projects');
}

// A Windows-safe folder name: no <>:"/\|?*, no leading/trailing dots or spaces.
const folderName = (name) => String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60);

// coder: default coding agent; alternativeAvailable: whether the other coder can be offered by voice.
// takeOver: async () => { project } — stops the background Claude run and opens it interactively (laptop).
// projectsDir: where new projects are made (code_new_project is offered only when set).
export function createNoviTools({ memory, tasks, coder = 'novi-coder', alternativeAvailable = false, takeOver = null, projectsDir = null }) {
  const c = CODERS[coder] || CODERS['novi-coder'];
  // The coder the user named for this task (only when it isn't the default), and the one that will run.
  const named = ({ agent } = {}) => (CODERS[agent] && agent !== coder ? agent : null);
  const coderFor = (a) => CODERS[named(a) || coder] || c;
  const registry = new ToolRegistry()
    .add({
      name: 'list_projects',
      description: 'List the projects Novi knows, with their folders.',
      parameters: obj(),
      tier: 'low',
      describe: () => 'List projects',
      run: async () => ({ projects: memory.listProjects().map(({ name, path }) => ({ name, path })) }),
    })
    .add({
      name: 'remember_project',
      description: 'Remember a project name and its folder path on the laptop so it can be referred to by name later.',
      parameters: obj({ name: str('Short project name, e.g. "portfolio"'), path: str('Absolute folder path on the laptop') }, ['name', 'path']),
      tier: 'medium',
      describe: ({ name, path }) => `Remember project "${name}" at ${path}`,
      run: async ({ name, path }) => ({ remembered: memory.rememberProject(name, path) }),
    })
    .add({
      name: 'forget_project',
      description: 'Forget a remembered project.',
      parameters: obj({ name: str('Project name') }, ['name']),
      tier: 'medium',
      describe: ({ name }) => `Forget project "${name}"`,
      run: async ({ name }) => ({ forgotten: memory.forgetProject(name) }),
    })
    .add({
      name: 'code_start_task',
      description: 'Start the coding agent on a known project with a complete coding instruction. Progress is narrated to the user automatically.',
      parameters: obj({
        project: str('Known project name'),
        instruction: str('Clear, complete instruction for the coding agent'),
        // Only when both coders exist: the brain picks by how hard the job is; what the user named wins.
        ...(alternativeAvailable ? { agent: {
          type: 'string',
          enum: ['claude', 'novi-coder'],
          description: 'Which coder. If the user named one, use it ("Claude"/"Claude Code" → claude; "Novi Coder"/"the free one" → novi-coder). Otherwise decide by difficulty: novi-coder for small, quick edits (a typo, a rename, changing a text, colour or one line); claude for bigger work (features, bugs, refactors, tests, anything across several files).',
        } } : {}),
      }, ['project', 'instruction']),
      tier: 'medium',
      describe: (a) => `Start ${coderFor(a).title} on ${a.project}: "${a.instruction}"`,
      prompt: (a) => `I'll use ${coderFor(a).spoken}, on ${a.project}: ${String(a.instruction).trim().replace(/[.!?]+$/, '')}. Shall I start? ${alternativeAvailable ? `Say yes, no, or ${coderFor(a).otherSpoken}.` : 'Say yes or no.'}`,
      choices: (a = {}) => (alternativeAvailable ? [{ id: coderFor(a).other, label: coderFor(a).otherLabel, params: { $agent: coderFor(a).other } }] : undefined),
      run: async ({ project, instruction, agent, $agent }) => ({ started: true, task: tasks.start(project, instruction, { agent: $agent || named({ agent }) || undefined }), note: 'The coder is working on it; I will narrate the progress.' }),
    })
    .add({
      name: 'code_send_message',
      description: 'Send a follow-up instruction to the coding agent in the current or most recent task (same conversation).',
      parameters: obj({ instruction: str('What to tell the coding agent') }, ['instruction']),
      tier: 'low',
      describe: ({ instruction }) => `Tell the coder: "${instruction}"`,
      run: async ({ instruction }) => ({ sent: true, task: tasks.send(instruction) }),
    })
    .add({
      name: 'code_status',
      description: 'Get the current coding task state and its latest narrated updates.',
      parameters: obj(),
      tier: 'low',
      describe: () => 'Check the coding task',
      run: async () => tasks.status(),
    })
    .add({
      name: 'code_stop',
      description: 'Stop the running coding task.',
      parameters: obj(),
      tier: 'low',
      describe: () => 'Stop the coding task',
      run: async () => ({ stopped: await tasks.stop() }),
    })
    .add({
      name: 'code_allow_edits',
      description: 'Let the coding agent edit files in the current task without asking each time (commands and risky actions still ask).',
      parameters: obj({ allow: { type: 'boolean', description: 'true to auto-approve file edits for this task' } }, ['allow']),
      tier: 'medium',
      describe: ({ allow }) => (allow ? 'Let the coder edit files without asking for this task' : 'Ask before each file edit again'),
      run: async ({ allow }) => {
        tasks.setAllowEdits(allow);
        return { allowEdits: Boolean(allow) };
      },
    });
  if (projectsDir) {
    const AGENT = alternativeAvailable ? { agent: { type: 'string', enum: ['claude', 'novi-coder'], description: 'Which coder, only if the user named one. Default: Claude Code.' } } : {};
    registry.add({
      name: 'code_new_project',
      description: `Make a brand-new project from scratch ("make a new project called X, description Y, and build Z"): creates the folder in ${projectsDir} with a README (name + description), remembers it, and starts the coder on the instruction. Use this — not screen control or open_project — for new projects.`,
      parameters: obj({
        name: str('Project name the user said'),
        description: str('Project description the user said (optional)'),
        instruction: str('What the coder should build, complete and clear (optional: omit to only create the project)'),
        ...AGENT,
      }, ['name']),
      tier: 'medium',
      describe: (a) => `New project "${folderName(a.name)}"${a.instruction ? ` + ${coderFor(a).title}: "${a.instruction}"` : ''}`,
      detail: (a) => `Folder: ${path.join(projectsDir, folderName(a.name))}${a.description ? `\nDescription: ${a.description}` : ''}`,
      prompt: (a) => `I'll make a new project "${folderName(a.name)}"${a.instruction ? ` and have ${coderFor(a).spoken} build it: ${String(a.instruction).trim().replace(/[.!?]+$/, '')}. It's a new folder, so it won't ask before each file edit; commands still ask` : ''}. Shall I go ahead? Say yes or no.`,
      choices: (a = {}) => (alternativeAvailable && a.instruction ? [{ id: coderFor(a).other, label: coderFor(a).otherLabel, params: { $agent: coderFor(a).other } }] : undefined),
      run: async ({ name, description, instruction, agent, $agent }) => {
        const clean = folderName(name);
        if (!clean || /^\.+$/.test(clean)) throw new Error('Tell me a name for the project.');
        const folder = path.join(projectsDir, clean);
        if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`A project folder called "${clean}" already exists. Pick another name, or ask me to work on that project.`);
        fs.mkdirSync(folder, { recursive: true });
        const about = String(description || '').trim();
        fs.writeFileSync(path.join(folder, 'README.md'), `# ${clean}\n${about ? `\n${about}\n` : ''}`);
        const project = memory.rememberProject(clean, folder).name;
        if (!String(instruction || '').trim()) return { created: folder, project, note: `Made the project ${clean}. Tell me what to build in it.` };
        const brief = `${String(instruction).trim()}\n\nThis is a new, empty project called "${clean}"${about ? `: ${about}` : ''}. Start from scratch in this folder.`;
        const task = tasks.start(project, brief, { agent: $agent || named({ agent }) || undefined });
        tasks.setAllowEdits(true); // a brand-new folder: nothing to lose; commands still ask
        return { created: folder, project, started: true, task, note: `Made ${clean}; the coder is building it now.` };
      },
    });
  }
  if (takeOver) {
    registry.add({
      name: 'code_take_over',
      description: 'The user is back at the laptop and wants to continue the coding task themselves ("I\'m back, I\'ll take over", "main sambhal leta hun"): stops the background Claude Code run and opens Claude Code on the project with the same conversation.',
      parameters: obj({}, []),
      tier: 'low',
      describe: () => 'Open the coding task in Claude Code for you',
      run: async () => {
        const { project } = await takeOver();
        return { tookOver: true, project, note: `Opened Claude Code on ${project} with the same conversation. Over to you.` };
      },
    });
  }
  return registry;
}
