import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';

// Opens a project Novi remembers (Settings → Projects, or "remember my X project at …")
// in the editor the user names. Opening only, so no approval; editing still goes through Novi's approvals.
export const EDITORS = [
  { id: 'vscode', label: 'VS Code', names: ['vscode', 'vs code', 'code', 'visual studio code'], exe: ['Microsoft VS Code', 'Code.exe'] },
  { id: 'cursor', label: 'Cursor', names: ['cursor'], exe: ['cursor', 'Cursor.exe'] },
  { id: 'antigravity', label: 'Antigravity', names: ['antigravity', 'antigravity ide', 'anti gravity'], exe: ['Antigravity IDE', 'Antigravity IDE.exe'] },
  { id: 'kiro', label: 'Kiro', names: ['kiro'], exe: ['Kiro', 'Kiro.exe'] },
  { id: 'claude-code', label: 'Claude Code', names: ['claude-code', 'claude code', 'claude'], terminal: 'claude' },
];
const findEditor = (name) => EDITORS.find((e) => e.names.includes(String(name || '').trim().toLowerCase()));
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

export function createIdePlugin({ spawn = nodeSpawn, exists = fs.existsSync, localAppData = process.env.LOCALAPPDATA || '' } = {}) {
  return definePluginEntry({
    id: 'ide',
    name: 'Open projects in an editor',
    description: 'Opens a remembered project in VS Code, Cursor, Antigravity, Kiro or Claude Code.',
    register(api) {
      api.registerTool({
        name: 'open_project',
        description: 'Open one of the user\'s remembered projects on the laptop in an editor: VS Code, Cursor, Antigravity, Kiro, or Claude Code (opens a terminal in the folder with Claude Code started). Use the editor the user names; omit it only if they did not say.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name as remembered by Novi, e.g. "novi"' },
            editor: { type: 'string', description: 'vscode, cursor, antigravity, kiro or claude-code' },
          },
          required: ['project'],
        },
        async execute(_toolCallId, { project, editor } = {}) {
          const memory = api.runtime.memory;
          const found = memory.findProject(project);
          if (!found) {
            const known = memory.listProjects().map((p) => p.name);
            return reply(`I don't know a project called "${project}".${known.length ? ` Known projects: ${known.join(', ')}.` : ''} Tell me its folder and I'll remember it.`);
          }
          const wanted = editor || api.pluginConfig.default_editor;
          if (!wanted) return reply(`Which editor should I open ${found.name} in: VS Code, Cursor, Antigravity, Kiro or Claude Code?`);
          const ed = findEditor(wanted);
          if (!ed) return reply(`I can open projects in VS Code, Cursor, Antigravity, Kiro or Claude Code, not "${wanted}".`);

          let cmd;
          let args;
          if (ed.terminal) {
            // Windows Terminal treats ";" as "next command", so such folders can't be passed safely.
            if (found.path.includes(';')) return reply(`I can't open ${found.name} in ${ed.label}: its folder name contains ";".`);
            cmd = 'wt.exe';
            args = ['-d', found.path, ed.terminal];
          } else {
            cmd = path.join(localAppData, 'Programs', ...ed.exe);
            if (!exists(cmd)) return reply(`${ed.label} isn't installed on this laptop (looked for ${cmd}).`);
            args = [found.path];
          }
          const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
          child.on?.('error', (err) => api.logger?.warn?.(`open_project: ${err.message}`));
          child.unref?.();
          return reply(`Opened ${found.name} in ${ed.label}.`, { project: found.name, path: found.path, editor: ed.id });
        },
      });
    },
  });
}

export default createIdePlugin();
