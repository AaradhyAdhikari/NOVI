import { execFile } from 'node:child_process';

// Returns a human-readable warning if Claude Code is missing or logged out, else null.
export function checkClaude(command) {
  return new Promise((resolve) => {
    execFile(command, ['auth', 'status'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(`Claude Code was not found at "${command}". Install it, or set CLAUDE_PATH in .env.`);
      try {
        const status = JSON.parse(stdout);
        if (!status.loggedIn) return resolve('Claude Code is not logged in. Run `claude auth login` and choose your Claude.ai (Pro) account.');
        return resolve(null);
      } catch {
        return resolve(null);
      }
    });
  });
}
