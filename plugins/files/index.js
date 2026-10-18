import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';
import { createFileIndex, defaultRoots, queryOf } from './fileIndex.js';
import { readFileText } from './readers.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const KIND_EXT = { pdf: ['.pdf'], doc: ['.docx', '.doc', '.odt', '.pdf', '.md', '.txt'], sheet: ['.xlsx', '.xls', '.csv', '.tsv', '.ods'], slides: ['.pptx', '.ppt'], image: ['.png', '.jpg', '.jpeg', '.gif', '.webp'] };
const KIND_LABEL = { pdf: 'PDFs', doc: 'documents', sheet: 'sheets', slides: 'slide decks', image: 'pictures', any: 'files' };
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 60);
const firstSentences = (text, n = 2) => (String(text).match(/[^.!?]+[.!?]+/g) || [String(text)]).slice(0, n).join(' ').trim();

function openOnLaptop(p) {
  // explorer.exe opens a file with its default app (or a folder in Explorer); no shell involved.
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [p]] : process.platform === 'darwin' ? ['open', [p]] : ['xdg-open', [p]];
  // Not windowsHide: that asks Windows to start the window hidden, so the folder "opened" invisibly.
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  if (process.platform === 'win32') {
    // Novi runs in the background, so Windows may open the window behind the others: bring it forward.
    // The name goes in an environment variable, never into the command text.
    const title = path.basename(p, path.extname(p));
    setTimeout(() => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).AppActivate($env:NOVI_OPEN_TITLE) | Out-Null'], { env: { ...process.env, NOVI_OPEN_TITLE: title }, stdio: 'ignore', windowsHide: true });
      ps.on('error', () => {});
    }, 1500).unref?.();
  }
}

// To the Recycle Bin (Windows), so a mistake can be undone there; elsewhere (tests, dev boxes) removed.
// The path goes in an environment variable, never into the command text.
async function recycle(target) {
  if (process.platform !== 'win32') { fs.rmSync(target, { recursive: true, force: true }); return; }
  const script = "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:NOVI_DELETE_PATH; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
  await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, env: { ...process.env, NOVI_DELETE_PATH: target } }, (err) => (err ? reject(err) : resolve())));
}

function defaultDocs(home = os.homedir()) {
  return [path.join(home, 'OneDrive', 'ドキュメント'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'Documents')].find((d) => fs.existsSync(d)) || path.join(home, 'Documents');
}

// Move that works across drives too (rename fails with EXDEV there).
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
const freeName = (dir, name) => {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  return target;
};

export function createFilesPlugin({ roots, home = os.homedir(), docsDir, openPath = openOnLaptop, trash = recycle, onJob = () => {}, refreshMs = 15 * 60_000, readyWaitMs = 5000 } = {}) {
  let markReady;
  let isReady = false;
  const ready = new Promise((r) => { markReady = () => { isReady = true; r(); }; });
  const STILL = "I'm still listing your files for the first time (it takes a few minutes). Ask me again in a minute.";
  const entry = definePluginEntry({
    id: 'files',
    name: 'Files',
    description: 'Find, open, read and summarize files anywhere on the laptop (and Google Sheets); gather files about a topic into a folder.',
    register(api) {
      const dataDir = path.join(api.runtime.dataDir || path.join(home, '.novi'), 'files');
      const index = createFileIndex({ roots: roots || defaultRoots({ home }), home, file: path.join(dataDir, 'index.json') });
      const lastMoveFile = path.join(dataDir, 'last-move.json');
      const docs = docsDir || defaultDocs(home);

      // The second brain (plugins/brain) reads the same list and the same readers.
      if (api.runtime) {
        api.runtime.fileEntries = () => index.entries();
        api.runtime.readFileText = (p) => readFileText(p);
      }

      api.registerService({
        id: 'files-index',
        async start() {
          index.load();
          // The first full scan can take a while on a big laptop: answer from the saved list meanwhile.
          const scan = index.build().catch((err) => api.logger?.warn?.(`[files] scan failed: ${err.message}`));
          if (index.size()) markReady();
          else scan.then(markReady); // never blocks Novi's startup
          if (refreshMs > 0) setInterval(() => index.build().catch(() => {}), refreshMs).unref?.();
        },
      });

      const waitReady = () => Promise.race([ready, new Promise((r) => setTimeout(r, readyWaitMs))]);
      const best = async (query) => {
        await waitReady();
        const hit = index.search(query, { limit: 1 })[0];
        if (!hit && !isReady) throw new Error(STILL);
        if (!hit) throw new Error(`I couldn't find a file like "${query}" on the laptop.`);
        return hit;
      };

      api.registerTool({
        name: 'file_find',
        description: 'Find files or folders anywhere on the laptop by what the user calls them ("my DBMS notes", "the sales sheet"). Lists the best matches. Read-only.',
        parameters: obj({ query: str('What the user said, e.g. "DBMS notes pdf"') }, ['query']),
        async execute(_id, { query }) {
          await waitReady();
          const files = index.search(query, { limit: 5 }).map((f) => ({ name: f.name, folder: path.dirname(f.path), path: f.path, modified: f.modified, folderItself: f.dir || undefined }));
          return reply({ files, note: files.length ? undefined : isReady ? `Nothing like "${query}" on the laptop.` : STILL });
        },
      });

      // "Send me my resume": a tap-to-download link on the device that asked (a phone, from anywhere).
      api.registerTool({
        name: 'file_send_phone',
        description: 'Send one of the user\'s files to the device they asked from as a download link ("send me my resume", "send the DBMS notes to my phone"). One file, not folders; never files holding passwords or keys.',
        parameters: obj({ query: str('What the user called the file') }, ['query']),
        async execute(_id, { query }) {
          const hit = await best(query || '');
          const name = path.basename(hit.path);
          if (hit.dir) return reply({ error: `${name} is a folder. I send one file at a time: say which file in ${name}.` });
          if (/(?:^\.env|password|passwd|secret|credential|token|id_rsa|private[ _-]?key)|\.(?:pem|key|pfx|p12|kdbx|ppk)$/i.test(name)) return reply({ error: `I won't send ${name}: it looks like it holds passwords or keys.` });
          if (fs.statSync(hit.path).size > 200 * 1024 * 1024) return reply({ error: `${name} is over 200 MB, too big to send this way.` });
          const url = api.runtime.fileLink(hit.path);
          api.runtime.showLink({ url, label: `Download ${name}` });
          return reply({ sent: name, note: `Here is ${name}. Tap the link to download it.` });
        },
      });

      api.registerTool({
        name: 'file_open',
        description: 'Open a file or folder on the laptop by what the user calls it ("open my DBMS notes"). Opens it in its normal app. Only when the user says file, folder or a document type ("open portfolio" is the project, not a file). Read-only.',
        parameters: obj({ query: str('What the user called the file'), path: str('Optional: the exact path, when Novi already knows it (e.g. the folder it just made)') }),
        async execute(_id, { query, path: exact }) {
          if (exact && fs.existsSync(exact)) {
            await openPath(exact);
            return reply({ opened: path.basename(exact), folder: path.dirname(exact) });
          }
          const hit = await best(query || '');
          await openPath(hit.path);
          return reply({ opened: hit.name, folder: path.dirname(hit.path) });
        },
      });

      async function summarize(name, text, question) {
        const ask = question ? `Answer this from the file: ${question}` : 'Summarize it: the main points and any numbers or trends that matter.';
        const out = await api.runtime.privateComplete(`${ask} Reply in plain sentences (no lists, no markdown), short enough to read aloud first, details after.\nFile: ${name}\n---\n${text.slice(0, 12_000)}`);
        api.runtime.say(out, { kind: null, spoken: firstSentences(out) });
      }

      async function googleSheet(query) {
        const google = api.runtime.google;
        if (!google?.configured) throw new Error("Google isn't set up yet, so I can't read Google Sheets.");
        const r = google.resolve();
        if (r.error) throw new Error(`${r.error} (connect Google in Settings).`);
        const { words } = queryOf(query);
        const q = `${words.map((w) => `name contains '${w.replace(/'/g, "\\'")}'`).join(' and ') || "name != ''"} and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
        const found = await google.call(r.account, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&pageSize=5&fields=files(id,name,modifiedTime)`);
        const sheet = found.files?.[0];
        if (!sheet) throw new Error(`I couldn't find a Google Sheet like "${query}".`);
        const meta = await google.call(r.account, `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}?fields=sheets.properties.title`);
        const ranges = (meta.sheets || []).slice(0, 10).map((s) => `ranges=${encodeURIComponent(`'${s.properties.title}'`)}`).join('&');
        const data = await google.call(r.account, `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values:batchGet?${ranges}`);
        const text = (data.valueRanges || []).map((v) => `Sheet: ${v.range}\n${(v.values || []).map((row) => row.join('\t')).join('\n')}`).join('\n');
        return { name: `${sheet.name} (Google Sheet)`, text };
      }

      api.registerTool({
        name: 'file_summary',
        description: 'Read a file on the laptop (Word, PDF, Excel, CSV, PowerPoint, text, code) or a Google Sheet (where: "google") and summarize it, or answer a question about it. Works in the background: answer at once that you are reading it; the summary is spoken when ready, so keep helping with other requests meanwhile.',
        parameters: obj({ query: str('What the user called the file'), question: str('A question about the file, if any'), where: { type: 'string', enum: ['laptop', 'google'], description: '"google" for Google Sheets; default laptop' } }, ['query']),
        async execute(_id, { query, question, where }) {
          let job;
          let name;
          if (where === 'google') {
            name = query;
            job = googleSheet(query).then((s) => summarize(s.name, s.text, question));
          } else {
            const hit = await best(query);
            name = hit.name;
            job = readFileText(hit.path).then((text) => summarize(hit.name, text, question));
          }
          job = job.catch((err) => api.runtime.say(`I couldn't read ${name}: ${err.message}`, { kind: null }));
          onJob(job);
          return reply({ started: true, note: `Reading ${name}. I'll tell you when it's ready; ask me anything meanwhile.` });
        },
      });

      // "Take all the PDFs about DBMS and put them in a folder."
      const plan = ({ topic, kind = 'any', folder }) => {
        const exts = KIND_EXT[kind];
        const dest = path.join(docs, safeName(folder || topic));
        const files = index.search(`${topic} ${kind === 'any' ? '' : kind}`, { limit: 300 })
          .filter((f) => !f.dir && (!exts || exts.includes(path.extname(f.path).toLowerCase())) && path.dirname(f.path) !== dest);
        return { dest, files, label: KIND_LABEL[kind] || 'files' };
      };

      api.registerTool({
        name: 'file_gather',
        description: 'Gather files about a topic from anywhere on the laptop into one new folder ("take all the PDFs about DBMS and put them in a folder"). Moves them (undo with file_undo_move). Needs one approval listing the files.',
        parameters: obj({ topic: str('The topic words to look for in file names'), kind: { type: 'string', enum: ['pdf', 'doc', 'sheet', 'slides', 'image', 'any'], description: 'Which files; default any' }, folder: str('New folder name (default: the topic)') }, ['topic']),
        async execute(_id, params) {
          const { dest, files, label } = plan(params);
          if (!files.length) return reply({ moved: 0, note: `I couldn't find any ${label} about ${params.topic}.` });
          fs.mkdirSync(dest, { recursive: true });
          const moves = [];
          for (const f of files) {
            const to = freeName(dest, f.name);
            try { move(f.path, to); moves.push([f.path, to]); } catch { /* in use: skip it */ }
          }
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(lastMoveFile, JSON.stringify({ dest, moves }));
          openPath(dest);
          return reply({ moved: moves.length, folder: dest, note: `Moved ${moves.length} ${label} into ${path.basename(dest)}${moves.length < files.length ? ` (${files.length - moves.length} were in use)` : ''}.` });
        },
      });

      // Where a new folder goes: Documents unless the user names Desktop / Downloads / a folder they have.
      const placeFor = (where) => {
        const w = String(where || '').trim().toLowerCase().replace(/^(?:my|the)\s+/, '').replace(/\s+folder$/, '');
        // With OneDrive the real desktop is OneDrive\Desktop, even when an old C:\Users\…\Desktop is
        // still there (live 2026-10-17: the folder went to that one and never showed up).
        const desktop = fs.existsSync(path.join(home, 'OneDrive', 'Desktop')) ? path.join(home, 'OneDrive', 'Desktop') : path.join(home, 'Desktop');
        const known = { '': docs, documents: docs, docs, desktop, downloads: path.join(home, 'Downloads') };
        if (w in known) return known[w];
        const hit = index.search(`${w} folder`, { limit: 1 })[0];
        return hit?.dir ? hit.path : null;
      };
      const placeLabel = (dir) => path.basename(dir);
      const newFolderPlan = ({ name, where }) => {
        const clean = safeName(name);
        const parent = placeFor(where);
        return { clean, parent, dest: parent && clean ? path.join(parent, clean) : null };
      };
      api.registerTool({
        name: 'file_new_folder',
        description: 'Make a new, empty folder on the laptop with the name the user says ("make a folder called Hackathon Ideas", "… on my desktop", "… inside my College folder"). Documents unless they name a place. Opens it afterwards.',
        parameters: obj({ name: str('The folder name, exactly as the user said it'), where: str('Optional: desktop, downloads, documents, or the name of an existing folder to put it in') }, ['name']),
        async execute(_id, params) {
          const { clean, parent, dest } = newFolderPlan(params);
          if (!clean) return reply({ note: 'Tell me what to call the folder.' });
          if (!parent) return reply({ note: `I couldn't find a folder called ${params.where}.` });
          if (fs.existsSync(dest)) return reply({ note: `There's already a folder called ${clean} in ${placeLabel(parent)}.` });
          fs.mkdirSync(dest, { recursive: true });
          await openPath(dest);
          return reply({ created: dest, note: `Made the folder ${clean} in ${placeLabel(parent)}.` });
        },
      });

      // Rename one file or folder in place (files keep their extension when none is given).
      const renamePlan = ({ path: from, newName }) => {
        const clean = safeName(newName);
        if (!from || !clean) return null;
        const isFile = fs.existsSync(from) && fs.statSync(from).isFile();
        const ext = path.extname(from);
        const name = isFile && ext && !path.extname(clean) ? clean + ext : clean;
        return { from, name, to: path.join(path.dirname(from), name) };
      };
      api.registerTool({
        name: 'file_rename',
        description: 'Rename one file or folder on the laptop in place, given its exact path (e.g. the folder Novi just made: "rename it to demo").',
        parameters: obj({ path: str('Exact path of the file or folder'), newName: str('The new name') }, ['path', 'newName']),
        async execute(_id, params) {
          const plan = renamePlan(params);
          if (!plan) return reply({ note: 'Tell me the new name.' });
          if (!fs.existsSync(plan.from)) return reply({ note: "I can't find that anymore." });
          if (fs.existsSync(plan.to)) return reply({ note: `There's already something called ${plan.name} there.` });
          try {
            fs.renameSync(plan.from, plan.to);
          } catch (err) {
            if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) return reply({ note: `Windows says ${path.basename(plan.from)} is in use. Close any window using it, then ask me again.` });
            throw err;
          }
          return reply({ renamed: plan.to, note: `Renamed it to ${plan.name}.` });
        },
      });

      const lastMove = () => { try { return JSON.parse(fs.readFileSync(lastMoveFile, 'utf8')); } catch { return null; } };
      api.registerTool({
        name: 'file_undo_move',
        description: 'Undo the last file_gather: put the moved files back where they were.',
        parameters: obj({}),
        async execute() {
          const last = lastMove();
          if (!last?.moves?.length) return reply({ note: 'There is nothing to put back.' });
          let back = 0;
          for (const [from, to] of last.moves) {
            try { fs.mkdirSync(path.dirname(from), { recursive: true }); move(to, from); back += 1; } catch { /* gone or in use */ }
          }
          fs.rmSync(lastMoveFile, { force: true });
          return reply({ restored: back, note: `Put ${back} files back.` });
        },
      });

      // Delete one file or folder — the only way Novi deletes (live 2026-10-17: the AI deleted a folder
      // through screen control with no PIN). Always asks for the voice PIN; to the Recycle Bin.
      const desktopDir = () => (fs.existsSync(path.join(home, 'OneDrive', 'Desktop')) ? path.join(home, 'OneDrive', 'Desktop') : path.join(home, 'Desktop'));
      const deleteTarget = ({ path: exact, name, where }) => {
        if (exact) return fs.existsSync(exact) ? exact : null;
        const clean = String(name || '').trim().replace(/^(?:the|my)\s+/i, '').replace(/\s+(?:folder|file)$/i, '');
        if (!clean) return null;
        const places = where ? [placeFor(where)] : [desktopDir(), docs, path.join(home, 'Downloads'), home];
        for (const dir of places.filter(Boolean)) {
          const hit = fs.existsSync(dir) && fs.readdirSync(dir).find((n) => n.toLowerCase() === clean.toLowerCase());
          if (hit) return path.join(dir, hit);
        }
        const found = index.search(clean, { limit: 1 })[0];
        return found && found.name.toLowerCase() === clean.toLowerCase() ? found.path : null;
      };
      const isProtected = (target) => {
        const raw = String(target);
        if (/^[a-z]:[\\/]?$/i.test(raw) || /^[a-z]:[\\/](?:windows|program files|programdata)\b/i.test(raw)) return true;
        const r = path.resolve(raw).toLowerCase();
        const keep = [home, desktopDir(), path.join(home, 'Desktop'), docs, path.join(home, 'Downloads'), path.join(home, 'OneDrive'), process.cwd()].map((d) => path.resolve(d).toLowerCase());
        return r.split(/[\\/]+/).filter(Boolean).length <= 1 || keep.includes(r) || keep.some((d) => d.startsWith(r + path.sep)) || r.startsWith(path.resolve(process.cwd()).toLowerCase() + path.sep);
      };
      const what = (target) => `the ${fs.statSync(target).isDirectory() ? 'folder' : 'file'} ${path.basename(target)}`;
      api.registerTool({
        name: 'file_delete',
        description: 'Delete ONE file or folder on the laptop (to the Recycle Bin). The ONLY way to delete files or folders: never use screen control keys/clicks or laptop_run for it. Always asks for the user\'s PIN. path = exact path when known (e.g. the folder just opened), else name (+ where: desktop/downloads/documents).',
        parameters: obj({ path: str('Exact path, when known'), name: str('File or folder name the user said'), where: str('Optional: desktop, downloads, documents, or a folder name') }),
        async execute(_id, params) {
          const target = deleteTarget(params || {});
          if (!target) return reply({ note: "I can't find that." });
          if (isProtected(target)) return reply({ note: "I won't delete that — it's a main folder of your laptop." });
          const label = what(target);
          await trash(target);
          return reply({ deleted: target, note: `Deleted ${label} (it is in the Recycle Bin).` });
        },
      });

      api.on('before_tool_call', ({ toolName, params }) => {
        if (toolName === 'file_delete') {
          const target = deleteTarget(params || {});
          if (target && isProtected(target)) return { block: true, blockReason: "I won't delete that — it's a main folder of your laptop." };
          if (!target) return params?.path && isProtected(params.path) ? { block: true, blockReason: "I won't delete that — it's a main folder of your laptop." } : undefined;
          const title = `Delete ${what(target)}?`;
          return { requireApproval: { title, description: `${target}\nIt goes to the Recycle Bin.`, prompt: `${title} Say your PIN.`, severity: 'warning', category: 'files', grantable: false, pin: true } };
        }
        if (toolName === 'file_gather') {
          const { dest, files, label } = plan(params);
          if (!files.length) return undefined;
          return {
            requireApproval: {
              title: `Move ${files.length} ${label} about ${params.topic} into ${path.basename(dest)}`,
              description: files.slice(0, 20).map((f) => f.path).join('\n') + (files.length > 20 ? `\n…and ${files.length - 20} more` : ''),
              prompt: `Move ${files.length} ${label} about ${params.topic} into ${path.basename(dest)}. OK?`,
              severity: 'warning',
              category: 'files',
            },
          };
        }
        if (toolName === 'file_new_folder') {
          const { clean, parent, dest } = newFolderPlan(params);
          if (!dest || fs.existsSync(dest)) return undefined;
          return { requireApproval: { title: `Make a folder called ${clean} in ${placeLabel(parent)}`, description: dest, prompt: `Make a folder called ${clean} in ${placeLabel(parent)}. OK?`, severity: 'warning', category: 'files' } };
        }
        if (toolName === 'file_rename') {
          const plan = renamePlan(params);
          if (!plan || !fs.existsSync(plan.from) || fs.existsSync(plan.to)) return undefined;
          const line = `Rename ${path.basename(plan.from)} to ${plan.name}`;
          return { requireApproval: { title: line, description: plan.from, prompt: `${line}.`, severity: 'warning', category: 'files' } };
        }
        if (toolName === 'file_undo_move') {
          const n = lastMove()?.moves?.length || 0;
          if (!n) return undefined;
          return { requireApproval: { title: `Put ${n} files back`, prompt: `Put ${n} files back where they were. OK?`, severity: 'warning', category: 'files' } };
        }
        return undefined;
      }, { allTools: true });
    },
  });
  return { ...entry, ready };
}

export default createFilesPlugin();
