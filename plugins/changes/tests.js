// The project's own tests, without AI: which command runs them, and what the output says.
import fs from 'node:fs';
import path from 'node:path';

const exists = (dir, f) => fs.existsSync(path.join(dir, f));

export function testCommand(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const t = pkg?.scripts?.test;
    if (t && !/no test specified/i.test(t)) return 'npm test';
  } catch { /* no package.json */ }
  const pyproject = exists(dir, 'pyproject.toml') ? fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8') : '';
  const pyTests = exists(dir, 'tests') && fs.readdirSync(path.join(dir, 'tests')).some((f) => /^test_.*\.py$|_test\.py$/.test(f));
  if (exists(dir, 'pytest.ini') || /\[tool\.pytest/.test(pyproject) || pyTests) return 'python -m pytest -q';
  return null;
}

const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const num = (s) => (s === undefined ? 0 : Number(s));

// { passed, failed, failedNames } from vitest / jest / mocha / pytest output, else null.
export function parseTestOutput(output) {
  const out = String(output || '').replace(ANSI, '');
  let m;
  if ((m = /\bTests\s+(?:(\d+) failed \|\s*)?(?:\d+ skipped \|\s*)?(\d+) passed/.exec(out))) {
    const names = [...out.matchAll(/^\s*(?:FAIL|×)\s+\S+\s+>\s+(.+?)\s*$/gm)].map((x) => x[1]);
    return { passed: num(m[2]), failed: num(m[1]), failedNames: [...new Set(names)] };
  }
  if ((m = /\bTests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/.exec(out))) {
    const names = [...out.matchAll(/^\s*●\s+(.+?)\s*$/gm)].map((x) => x[1]).filter((n) => !/Test suite failed to run/.test(n));
    return { passed: num(m[2]), failed: num(m[1]), failedNames: [...new Set(names)] };
  }
  if ((m = /(\d+) passing/.exec(out))) {
    const f = /(\d+) failing/.exec(out);
    return { passed: num(m[1]), failed: f ? num(f[1]) : 0, failedNames: [] };
  }
  if ((m = /=+ (?:(\d+) failed,? ?)?(?:(\d+) passed)?[^=\n]* in [\d.]+s/.exec(out)) && (m[1] || m[2])) {
    const names = [...out.matchAll(/^FAILED [^:\s]+::(\S+)/gm)].map((x) => x[1]);
    return { passed: num(m[2]), failed: num(m[1]), failedNames: names };
  }
  return null;
}

export function testSummary(result, code, output = '') {
  if (result && !result.failed) return `All ${result.passed} tests passed.`;
  if (result) {
    const names = result.failedNames.slice(0, 5);
    return `${result.passed} passed, ${result.failed} failed${names.length ? `: ${names.join('; ')}` : ''}.`;
  }
  const last = String(output).replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) || '(no output)';
  return code
    ? `The tests didn't run cleanly (exit code ${code}), and I couldn't read a result. Last line: ${last}`
    : `The tests finished, but I couldn't read how many passed. Last line: ${last}`;
}
