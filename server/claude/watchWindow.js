// Laptop windows for Claude Code tasks started by voice (e.g. from a walk):
//   watch     — a Windows Terminal window in the project that follows the task's progress log
//   take over — interactive Claude Code in the project, resuming the same conversation
// Arguments go to wt.exe as an array (no shell); wt itself splits on ";" so those are escaped.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const wtSafe = (s) => String(s).replace(/;/g, '\\;');
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const clock = () => new Date().toTimeString().slice(0, 8);

export function createWatchWindows({ dir, claudeCommand = 'claude', platform = process.platform, run = spawn, exists = fs.existsSync, logger = console }) {
  const logPath = (taskId) => path.join(dir, `${taskId}.log`);
  const append = (taskId, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath(taskId), `${clock()}  ${String(text).replace(/\s*\n\s*/g, ' ')}\n`);
  };
  const open = (title, cwd, command) => {
    if (platform !== 'win32') return false;
    try {
      const child = run('wt.exe', ['-w', 'new', '--title', title, '-d', wtSafe(cwd), ...command.map(wtSafe)], { detached: true, stdio: 'ignore' });
      child.on?.('error', (err) => logger.warn?.(`[claude] window failed: ${err.message}`));
      child.unref?.();
      return true;
    } catch (err) {
      logger.warn?.(`[claude] window failed: ${err.message}`);
      return false;
    }
  };
  return {
    logPath,
    append,
    openWatch({ taskId, project, path: cwd, instruction }) {
      append(taskId, `Claude Code is working on ${project}: ${instruction}`);
      // wt.exe refuses to start in a folder that's gone (error 0x8007010b); the log folder always exists.
      if (!exists(cwd)) cwd = dir;
      append(taskId, 'Its questions go to your phone. Back at the laptop? Say "I\'m back, I\'ll take over".');
      return open(`Claude · ${project}`, cwd, ['powershell.exe', '-NoExit', '-NoProfile', '-Command', `Get-Content -Wait -Encoding UTF8 -LiteralPath ${psQuote(logPath(taskId))}`]);
    },
    openTakeOver({ project, path: cwd, sessionId }) {
      if (!exists(cwd)) {
        logger.warn?.(`[claude] can't take over: ${cwd} no longer exists`);
        return false;
      }
      return open(`Claude · ${project}`, cwd, [claudeCommand, '--resume', sessionId]);
    },
  };
}
