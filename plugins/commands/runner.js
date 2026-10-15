// Runs one PowerShell command line for Novi: a fresh hidden powershell.exe in the user's home
// folder, never elevated, the script passed -EncodedCommand (no quoting surprises), stopped after
// 60 s, output cut at 4,000 characters. Look-only commands are first re-checked by PowerShell's
// own parser: if any command or method in them is not on the read list, nothing runs and the
// result says notLook (the tool then asks as a change).
import { spawn } from 'node:child_process';
import { READ_COMMANDS, SAFE_METHODS } from './classify.js';

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const list = (items) => `@(${[...items].map(quote).join(',')})`;

export function buildScript(command, look) {
  const run = [
    `$novi = ${quote(command)}`,
    "$ErrorActionPreference = 'Stop'",
    'try { & ([ScriptBlock]::Create($novi)) 2>&1 | Out-String -Width 200 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
  ];
  if (!look) return run.join('\n');
  const check = [
    `$read = ${list(READ_COMMANDS)}`,
    `$safe = ${list(SAFE_METHODS)}`,
    '$errs = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseInput(${quote(command)}, [ref]$null, [ref]$errs)`,
    "if ($errs.Count) { 'NOVI-NOT-LOOK'; exit 3 }",
    '$cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)',
    '$bad = @($cmds | Where-Object {',
    '  $name = $_.GetCommandName(); if (-not $name) { return $true }',
    '  $n = $name.ToLower(); $al = Get-Alias -Name $n -ErrorAction SilentlyContinue; if ($al) { $n = $al.ResolvedCommandName.ToLower() }',
    "  $n = $n -replace '\\.exe$', ''",
    "  -not (($read -contains $n) -or ($n.StartsWith('get-') -and $n -ne 'get-credential'))",
    '})',
    "$force = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandParameterAst] -and @('force','install','acceptall','download','autoreboot','delete','remove','kill','stop','reset','clear') -contains $n.ParameterName.ToLower() }, $true))",
    "$ipc = @($cmds | Where-Object { $_.GetCommandName() -match '^ipconfig' -and \"$_\" -match '/(release|renew|flushdns|registerdns|setclassid)' })",
    '$calls = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | Where-Object { -not ($safe -contains $_.Member.Value.ToLower()) })',
    '$redir = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst] }, $true))',
    "if ($bad.Count -or $force.Count -or $ipc.Count -or $calls.Count -or $redir.Count) { 'NOVI-NOT-LOOK'; exit 3 }",
  ];
  return [...check, ...run].join('\n');
}

export function createRunner({ spawnImpl = spawn, platform = process.platform, home, timeoutMs = 60_000, maxOutput = 4000 } = {}) {
  return {
    run({ command, look = false }) {
      if (platform !== 'win32') return Promise.reject(new Error('not-windows'));
      const encoded = Buffer.from(buildScript(command, look), 'utf16le').toString('base64');
      const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
      return new Promise((resolve) => {
        let done = false;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
        const finish = (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          let output = [out.trimEnd(), err.trimEnd()].filter(Boolean).join('\n');
          if (output.length > maxOutput) output = `${output.slice(0, maxOutput)}\n…(cut)`;
          if (timedOut) return resolve({ ok: false, timedOut: true, exitCode: null, output });
          if (look && code === 3 && out.includes('NOVI-NOT-LOOK')) return resolve({ ok: false, notLook: true, exitCode: 3, output: '' });
          resolve({ ok: code === 0, exitCode: code, output });
        };
        child.on('close', finish);
        child.on('error', (e) => { err += String(e.message || e); finish(-1); });
      });
    },
  };
}
