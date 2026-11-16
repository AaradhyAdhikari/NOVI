// Novi Flick by voice, no AI: "open the stage" / "flick mode", "close the stage", "open the last flick".
const LEAD = /^(?:okay|ok|hey novi|novi|please|can you|could you)[,\s]+/i;
const clean = (t) => String(t || '').trim().replace(/[.!?]+$/, '').replace(LEAD, '').replace(/\s+please$/i, '').trim().toLowerCase();

export function flickCommand(text) {
  const t = clean(text);
  if (/^(?:open|show|start|bring up)(?: the| my| novi)? (?:stage|flick stage)$|^(?:flick|stage) mode(?: on)?$|^stage kholo$/.test(t)) return { tool: 'flick_stage', args: { do: 'open' } };
  if (/^(?:close|hide|stop|end)(?: the| my| novi)? (?:stage|flick stage)$|^(?:flick|stage) mode off$|^stage band karo$/.test(t)) return { tool: 'flick_stage', args: { do: 'close' } };
  if (/^open (?:the |my )?(?:last|latest|newest) (?:flick|flicked (?:thing|file|item))$|^open what i (?:just )?flicked$/.test(t)) return { tool: 'flick_open', args: {} };
  return null;
}
