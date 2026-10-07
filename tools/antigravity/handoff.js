// Dev tool (not part of Novi): Claude Code hands small, well-specified tasks to the
// Antigravity IDE agent (free tier) and waits for its result file. See docs/ANTIGRAVITY.md.
//
//   node tools/antigravity/handoff.js send --title "..." --files a.js,b.js --verify "npx vitest run x" < instructions.md
//   node tools/antigravity/handoff.js wait <id> [--timeout 900]
//   node tools/antigravity/handoff.js list
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirs = (root) => ({
  tasks: path.join(root, '.handoff', 'tasks'),
  done: path.join(root, '.handoff', 'done')
})

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export function createTask({ root, title, instructions, files = [], verify, now = new Date() }) {
  if (!title?.trim()) throw new Error('title is required')
  if (!instructions?.trim()) throw new Error('instructions are required')
  const id = `${stamp(now)}-${slug(title)}`
  const { tasks } = dirs(root)
  fs.mkdirSync(tasks, { recursive: true })
  const donePath = `.handoff/done/${id}.md`
  const text = [
    `# Task ${id}: ${title.trim()}`,
    '',
    'You were handed this task by Claude Code. Do exactly this task and nothing else.',
    '',
    '## Instructions',
    instructions.trim(),
    '',
    '## Files you may change',
    files.length ? files.map((f) => `- ${f}`).join('\n') : '- (only what the instructions name)',
    '',
    '## Rules',
    '- Do not commit or push. Do not run git commands that change history.',
    '- Never read, print or change `.env`, `data/` or `NOVI CONTEXT.txt`.',
    '- Do not install new packages or touch files outside the list above.',
    '- If something is unclear or blocked, stop and report it instead of guessing.',
    '- Windows PowerShell blocks `npm`/`npx` scripts here: run `npm.cmd` / `npx.cmd` instead.',
    verify ? `- When finished, run: \`${verify}\` and include the last lines of its output.` : '',
    '',
    '## When you are done',
    `Create the file \`${donePath}\` with this shape:`,
    '```',
    'STATUS: done        (or: STATUS: blocked)',
    'FILES: <files you changed>',
    'SUMMARY: <what you did, 1-5 lines>',
    'VERIFY: <last lines of the verify command output, if any>',
    '```',
    ''
  ].join('\n')
  const taskPath = path.join(tasks, `${id}.md`)
  fs.writeFileSync(taskPath, text)
  return { id, taskPath, donePath }
}

// Antigravity's `chat` CLI subcommand is VS Code's and never reaches the Agent panel,
// so this one-line prompt is typed into the Agent panel (by Claude via screen control, or pasted).
export function buildPrompt(id) {
  return `Read .handoff/tasks/${id}.md in this workspace and carry out the task exactly as written, including writing the result file it asks for.`
}

export function readResult({ root, id }) {
  const file = path.join(dirs(root).done, `${id}.md`)
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/^STATUS:\s*(\w+)/m)
  return { status: m ? m[1].toLowerCase() : 'unknown', text }
}

export async function waitForResult({ root, id, timeoutMs = 15 * 60_000, intervalMs = 3000 }) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const r = readResult({ root, id })
    if (r) return r
    if (Date.now() >= end) return { status: 'timeout', text: '' }
    await new Promise((res) => setTimeout(res, intervalMs))
  }
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

async function main(argv) {
  const root = process.cwd()
  const [cmd, arg] = argv
  if (cmd === 'send') {
    const instructions = flag(argv, 'text') ?? fs.readFileSync(0, 'utf8')
    const files = (flag(argv, 'files') || '').split(',').map((s) => s.trim()).filter(Boolean)
    const t = createTask({ root, title: flag(argv, 'title'), instructions, files, verify: flag(argv, 'verify') })
    console.log(t.id)
    console.log(buildPrompt(t.id))
  } else if (cmd === 'wait') {
    const timeoutMs = Number(flag(argv, 'timeout') || 900) * 1000
    const r = await waitForResult({ root, id: arg, timeoutMs })
    console.log(r.text || `STATUS: ${r.status}`)
    process.exitCode = r.status === 'done' ? 0 : 1
  } else if (cmd === 'list') {
    const { tasks } = dirs(root)
    for (const f of fs.existsSync(tasks) ? fs.readdirSync(tasks) : []) {
      const id = f.replace(/\.md$/, '')
      console.log(`${id}  ${readResult({ root, id })?.status ?? 'pending'}`)
    }
  } else {
    console.log('usage: handoff.js send --title T [--files a,b] [--verify CMD] [--text T | < file] | wait <id> [--timeout s] | list')
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2))
}
