// Novi's own actions, one line each in Actions/YYYY-MM-DD.md, plus the newest 20 kept in memory so
// "rename it" / "open the folder you just made" know what "it" is.
import path from 'node:path';

const base = (p) => path.basename(String(p).replace(/[\\/]+$/, '').replace(/\\/g, '/'));
const nameOf = (p) => base(p);

// → { verb, name, path } for a successful run worth logging, else null.
export function describeAction(tool, params = {}, result = {}) {
  if (!result || result.error) return null;
  switch (tool) {
    case 'file_new_folder': return result.created ? { verb: 'Made folder', name: nameOf(result.created), path: result.created } : null;
    case 'file_rename': return result.renamed ? { verb: 'Renamed to', name: nameOf(result.renamed), path: result.renamed } : null;
    case 'rename_project': return result.renamed ? { verb: 'Renamed project to', name: result.project || nameOf(result.renamed), path: result.renamed, project: true } : null;
    case 'file_open': return result.opened ? { verb: 'Opened', name: result.opened, path: result.folder ? path.join(result.folder, result.opened) : '' } : null;
    case 'open_project': return result.path ? { verb: 'Opened project', name: result.project || nameOf(result.path), path: result.path, project: true } : null;
    case 'file_gather': return result.moved ? { verb: `Moved ${result.moved} files into`, name: nameOf(result.folder || ''), path: result.folder || '' } : null;
    case 'file_undo_move': return result.restored ? { verb: `Put ${result.restored} files back`, name: '', path: '' } : null;
    case 'code_start_task': return result.started || result.active ? { verb: 'Started a coding job on', name: params.project || '', path: result.path || '', project: true } : null;
    case 'code_new_project': return result.created ? { verb: 'Made project', name: result.project || nameOf(result.created), path: result.created, project: true } : null;
    case 'open_app': return result.opened ? { verb: 'Opened app', name: result.opened, path: '' } : null;
    case 'open_website': return result.opened ? { verb: 'Opened website', name: result.opened, path: result.opened } : null;
    case 'play_youtube': return result.playing ? { verb: 'Played', name: result.playing.title || params.query || '', path: result.playing.url || '' } : null;
    default: return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const actionLine = (a, d) => `- ${hhmm(d)} ${a.verb}${a.name ? ` **${a.name}**` : ''}${a.path ? ` — ${a.path}` : ''}`;

export function createActionLog({ vault, now = () => new Date(), keep = 20, logger }) {
  const recentList = [];
  return {
    record({ toolName, params, result, error }) {
      if (error) return null;
      const a = describeAction(toolName, params, result);
      if (!a) return null;
      const at = now();
      const entry = { at: at.toISOString(), tool: toolName, ...a };
      recentList.unshift(entry);
      if (recentList.length > keep) recentList.length = keep;
      try {
        vault.append(path.join('Actions', `${day(at)}.md`), `${actionLine(a, at)}\n`);
      } catch (err) {
        logger?.warn?.(`[wiki] could not write the actions log: ${err.message}`);
      }
      return entry;
    },
    recent: (n = 5) => recentList.slice(0, n),
    today: () => recentList.filter((a) => day(new Date(a.at)) === day(now())),
  };
}
