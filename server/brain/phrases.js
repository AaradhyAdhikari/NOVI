// Words people put around a request that don't change it: "Okay, can you … on my laptop right now".
export const FILE_LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|so|now|please|can you|could you|would you|will you|just)[\s,]+)+/i;
export const FILE_TAIL = /(?:[\s,]+(?:(?:on|in) (?:(?:my|the) )?(?:laptop|computer|pc)|for me|right now|now|please|quickly))+$/i;
export const clean = (text) => String(text || '').trim().replace(/[.!?।]+$/, '').replace(FILE_LEAD, '').replace(FILE_TAIL, '').trim();
