// "Start screen control" / "screen mode on": the only words that turn Screen Mode on from outside
// (plugins/screen/mode.js reads everything else once it's on).
const START = /^(?:(?:novi|hey novi|okay|ok|please)[, ]+)*(?:start|turn on|switch on|begin|enable|open) (?:the )?screen (?:control|mode)(?: mode)?(?: please)?$|^screen (?:control|mode) (?:on|start|chalu karo|shuru karo)$/i;

export const isScreenModeStart = (text) => START.test(String(text || '').trim().replace(/[.!?]+$/, ''));
