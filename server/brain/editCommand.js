// "Make it shorter" with text selected in any app, without the AI brain (plugins/rewrite). Only the
// whole sentence counts, so "make it blue" or "fix it" keep their meaning.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)+/i;
const IT = '(?:it|this|that)';

export function editCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  const edit = (how) => ({ tool: 'text_edit_selection', args: { how } });
  let m;
  if (new RegExp(`^(?:make ${IT}(?: a bit| a little| much)? (?:shorter|concise)|shorten ${IT}|(?:isko|ise|ye) chhota karo)$`, 'i').test(t)) return edit('shorter');
  if (new RegExp(`^(?:turn|make|convert|change) ${IT}(?: (?:in)?to)?(?: a)? (?:bullets?|bullet points|list)$`, 'i').test(t)) return edit('bullets');
  if (new RegExp(`^make ${IT}(?: more)? (?:formal|professional)$`, 'i').test(t)) return edit('formal');
  if (new RegExp(`^make ${IT}(?: more)? (?:casual|friendly)$`, 'i').test(t)) return edit('casual');
  if (/^(?:fix|correct) (?:the )?(?:grammar|spelling)$/i.test(t)) return edit('grammar');
  if ((m = new RegExp(`^translate ${IT} (?:in)?to ([\\p{L}]+)$`, 'iu').exec(t))) return edit(`translate:${m[1]}`);
  return null;
}
