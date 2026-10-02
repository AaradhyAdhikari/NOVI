import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isInside } from '../permissions.js';
import { killTree } from '../claude/session.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache', 'coverage']);
const MAX_READ_CHARS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const s = (description) => ({ type: 'string', description });

export const CODER_TOOLS = [
  fn('list_files', 'List files in the project (recursive; skips node_modules, .git and build output). Paths are relative to the project root.', { path: s('Folder to list, relative to the project root. Default "."') }),
  fn('read_file', 'Read a text file with line numbers.', { path: s('File path relative to the project root'), offset: { type: 'integer', description: 'First line to read (1-based). Default 1' }, limit: { type: 'integer', description: 'Maximum lines to read. Default 400' } }, ['path']),
  fn('search', 'Search file contents with a case-insensitive regular expression. Returns "file:line: text" lines.', { pattern: s('Regular expression'), path: s('Folder to search, relative. Default "."') }, ['pattern']),
  fn('write_file', 'Create or overwrite a file with its complete content.', { path: s('File path relative to the project root'), content: s('Complete file content') }, ['path', 'content']),
  fn('edit_file', 'Replace one exact, unique occurrence of old_text with new_text. Read the file first and copy old_text exactly.', { path: s('File path relative to the project root'), old_text: s('Exact text to replace; must occur exactly once'), new_text: s('Replacement text') }, ['path', 'old_text', 'new_text']),
  fn('run_command', 'Run a shell command in the project folder (cmd.exe on Windows). 120 second timeout. Use for tests, builds, git status and installs.', { command: s('The command line to run') }, ['command']),
];

// Claude-style names, so permission tiers and narration are shared with the Claude Code adapter.
export const TOOL_ALIASES = { list_files: 'Glob', read_file: 'Read', search: 'Grep', write_file: 'Write', edit_file: 'Edit', run_command: 'Bash' };

export function resolveInProject(root, relPath = '.') {
  const abs = path.resolve(root, String(relPath || '.'));
  if (!isInside(root, abs)) throw new Error(`Path is outside the project folder: ${relPath}`);
  return abs;
}

export function aliasInput(root, name, args = {}) {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return { file_path: resolveInProject(root, args.path) };
    case 'list_files':
      return { path: resolveInProject(root, args.path) };
    case 'search':
      return { pattern: String(args.pattern || ''), path: resolveInProject(root, args.path) };
    case 'run_command':
      return { command: String(args.command || '') };
    default:
      return {};
  }
}

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

async function walk(dir, out, limit) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(abs, out, limit);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export async function listFiles(root, args = {}) {
  const files = [];
  await walk(resolveInProject(root, args.path), files, 301);
  const lines = files.slice(0, 300).map((f) => rel(root, f));
  if (files.length > 300) lines.push('… (more files not shown)');
  return lines.join('\n') || '(no files)';
}

export async function readFile(root, args) {
  const lines = (await fs.readFile(resolveInProject(root, args.path), 'utf8')).split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.max(1, Number(args.limit) || 400);
  let out = lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}\t${line}`).join('\n');
  if (out.length > MAX_READ_CHARS) out = `${out.slice(0, MAX_READ_CHARS)}\n… (truncated)`;
  const end = offset - 1 + limit;
  if (end < lines.length) out += `\n… (${lines.length - end} more lines; use offset ${end + 1})`;
  return out;
}

export async function search(root, args) {
  let re;
  try { re = new RegExp(args.pattern, 'i'); } catch (err) { throw new Error(`Invalid regular expression: ${err.message}`); }
  const files = [];
  await walk(resolveInProject(root, args.path), files, 5000);
  const hits = [];
  for (const file of files) {
    if ((await fs.stat(file)).size > 1_000_000) continue;
    const text = await fs.readFile(file, 'utf8');
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < 100; i++) {
      if (re.test(lines[i])) hits.push(`${rel(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
    if (hits.length >= 100) break;
  }
  return hits.join('\n') || 'No matches.';
}

export async function writeFile(root, args) {
  const abs = resolveInProject(root, args.path);
  const content = String(args.content ?? '');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return `Wrote ${rel(root, abs)} (${content.length} characters).`;
}

export async function editFile(root, args) {
  const abs = resolveInProject(root, args.path);
  const text = await fs.readFile(abs, 'utf8');
  const oldText = String(args.old_text ?? '');
  if (!oldText) throw new Error('old_text must not be empty.');
  const count = text.split(oldText).length - 1;
  if (count === 0) throw new Error('old_text was not found; read the file and copy the exact text.');
  if (count > 1) throw new Error(`old_text occurs ${count} times; include more surrounding lines to make it unique.`);
  await fs.writeFile(abs, text.replace(oldText, () => String(args.new_text ?? '')));
  return `Edited ${rel(root, abs)}.`;
}

export function runCommand(root, args, { timeoutMs = 120_000, onChild } = {}) {
  return new Promise((resolve) => {
    const child = spawn(String(args.command), { cwd: root, shell: true, windowsHide: true });
    onChild?.(child);
    let output = '';
    const add = (chunk) => { if (output.length < MAX_OUTPUT_CHARS) output += chunk; };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ isError: true, output: `Could not run the command: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = output.length >= MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (output truncated)` : output;
      resolve({ isError: timedOut || code !== 0, output: `${timedOut ? 'Timed out. ' : ''}Exit code ${code}\n${body}`.trim() });
    });
  });
}

export async function runTool(root, name, args, opts) {
  try {
    switch (name) {
      case 'list_files': return { isError: false, output: await listFiles(root, args) };
      case 'read_file': return { isError: false, output: await readFile(root, args) };
      case 'search': return { isError: false, output: await search(root, args) };
      case 'write_file': return { isError: false, output: await writeFile(root, args) };
      case 'edit_file': return { isError: false, output: await editFile(root, args) };
      case 'run_command': return await runCommand(root, args, opts);
      default: return { isError: true, output: `Unknown tool ${name}` };
    }
  } catch (err) {
    return { isError: true, output: err.message };
  }
}
