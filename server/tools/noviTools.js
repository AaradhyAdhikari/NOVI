import { ToolRegistry } from './registry.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });

const CODERS = {
  'novi-coder': { title: 'Novi Coder (free, Groq)', spoken: 'Novi Coder, free on Groq', other: 'claude', otherLabel: 'Use Claude', otherSpoken: 'use Claude instead' },
  claude: { title: 'Claude Code (your Claude plan)', spoken: 'Claude Code, on your Claude plan', other: 'novi-coder', otherLabel: 'Use Novi Coder', otherSpoken: 'use Novi Coder instead' },
};

// coder: default coding agent; alternativeAvailable: whether the other coder can be offered by voice.
export function createNoviTools({ memory, tasks, coder = 'novi-coder', alternativeAvailable = false }) {
  const c = CODERS[coder] || CODERS['novi-coder'];
  return new ToolRegistry()
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
      parameters: obj({ project: str('Known project name'), instruction: str('Clear, complete instruction for Claude Code') }, ['project', 'instruction']),
      tier: 'medium',
      describe: ({ project, instruction }) => `Start ${c.title} on ${project}: "${instruction}"`,
      prompt: ({ project, instruction }) => `I'll use ${c.spoken}, on ${project}: ${String(instruction).trim().replace(/[.!?]+$/, '')}. Shall I start? ${alternativeAvailable ? `Say yes, no, or ${c.otherSpoken}.` : 'Say yes or no.'}`,
      choices: () => (alternativeAvailable ? [{ id: c.other, label: c.otherLabel, params: { $agent: c.other } }] : undefined),
      run: async ({ project, instruction, $agent }) => ({ started: true, task: tasks.start(project, instruction, { agent: $agent }), note: 'The coder is working on it; I will narrate the progress.' }),
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
}
