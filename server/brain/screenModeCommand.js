// "Start screen control" / "screen mode on": the only words that turn Screen Mode on from outside
// (plugins/screen/mode.js reads everything else once it's on).
const START = /^(?:(?:novi|hey novi|okay|ok|please)[, ]+)*(?:start|turn on|switch on|begin|enable|open) (?:the )?screen (?:control|mode)(?: mode)?(?: please)?$|^screen (?:control|mode) (?:on|start|chalu karo|shuru karo)$/i;

const LIVE = /^(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)*(?:(?:open|start|show(?: me)?)\s+)?(?:(?:the|my)\s+)?(?:live (?:screen|view)|laptop live(?: dikhao)?|laptop screen live)(?:\s+(?:on|from)\s+(?:my |the )?phone)?$|^(?:remote )?control (?:my|the) laptop(?:\s+(?:from|on)\s+(?:here|(?:my |the )?phone))?$|^show (?:me )?my laptop live$/i;
export const isLiveStart = (text) => LIVE.test(String(text || '').trim().replace(/[.!?]+$/, ''));

export const isScreenModeStart = (text) => START.test(String(text || '').trim().replace(/[.!?]+$/, ''));
