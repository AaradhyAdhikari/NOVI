// "Make it shorter" with text selected in any app, without the AI brain (plugins/rewrite). Only the
// whole sentence counts, so "make it blue" or "fix it" keep their meaning.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)+/i;
const IT = '(?:it|this|that)';

const WORD = { one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5 };
const COUNT = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
const howMany = (w) => (w ? WORD[String(w).toLowerCase()] ?? Number(w) : 1);
const LINES = `(?:(?:the )?(first|last)(?: ${COUNT})? lines?)`;

export function editCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  const edit = (how) => ({ tool: 'text_edit_selection', args: { how } });
  let m;
  if (/^(?:select (?:all(?: (?:of )?(?:the|this|my) text)?|everything|(?:the|all the) text)|(?:sab|sara|poora) select karo)$/i.test(t)) return { tool: 'laptop_select', args: { what: 'all' } };
  if (/^select (?:this|the|current) line$/i.test(t)) return { tool: 'laptop_select', args: { what: 'line' } };
  if ((m = new RegExp(`^select ${LINES}$`, 'i').exec(t))) return { tool: 'laptop_select', args: { what: m[1].toLowerCase(), n: howMany(m[2]) } };
  if ((m = new RegExp(`^copy ${LINES}$`, 'i').exec(t))) return { tool: 'screen_copy_lines', args: { from: m[1].toLowerCase(), n: howMany(m[2]) } };
  if ((m = /^(pehli|pahli|aakhri|akhri)(?: (ek|do|teen|char|chaar|paanch|\d+))? lines? copy karo$/i.exec(t))) return { tool: 'screen_copy_lines', args: { from: /^p/i.test(m[1]) ? 'first' : 'last', n: howMany(m[2]) } };
  if (new RegExp(`^(?:make ${IT}(?: a bit| a little| much)? (?:shorter|concise)|shorten ${IT}|(?:isko|ise|ye) chhota karo)$`, 'i').test(t)) return edit('shorter');
  if (new RegExp(`^(?:turn|make|convert|change) ${IT}(?: (?:in)?to)?(?: a)? (?:bullets?|bullet points|list)$`, 'i').test(t)) return edit('bullets');
  if (new RegExp(`^make ${IT}(?: more)? (?:formal|professional)$`, 'i').test(t)) return edit('formal');
  if (new RegExp(`^make ${IT}(?: more)? (?:casual|friendly)$`, 'i').test(t)) return edit('casual');
  if (/^(?:fix|correct) (?:the )?(?:grammar|spelling)$/i.test(t)) return edit('grammar');
  if ((m = new RegExp(`^translate ${IT} (?:in)?to ([\\p{L}]+)$`, 'iu').exec(t))) return edit(`translate:${m[1]}`);
  return null;
}
