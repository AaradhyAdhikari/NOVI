// Novi Flick, phone side: what counts as a flick, and the request that sends an item to the laptop.
export function isFlick({ dy, ms }) {
  if (dy >= 0) return false;
  if (dy <= -110) return true;
  return dy <= -40 && -dy / Math.max(ms, 1) >= 0.6; // short but fast
}

export function flickRequest({ file, link }) {
  const url = '/api/plugin-upload/flick';
  if (link) return { url, init: { method: 'POST', body: String(link), headers: { 'content-type': 'application/octet-stream', 'x-novi-kind': 'link', 'x-novi-name': 'link' } } };
  return {
    url,
    init: {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream', 'x-novi-kind': 'file', 'x-novi-name': encodeURIComponent(file.name || 'file'), 'x-novi-type': file.type || '' },
    },
  };
}

export function itemKind({ file, link }) {
  if (link) return 'link';
  const n = file?.name || '', t = file?.type || '';
  if (/^image\//.test(t) || /\.(jpe?g|png|gif|webp|heic)$/i.test(n)) return 'photo';
  if (/^video\//.test(t) || /\.(mp4|mov|webm|mkv)$/i.test(n)) return 'video';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md|csv)$/i.test(n)) return 'doc';
  return 'file';
}

export const wantsFlick = (search) => new URLSearchParams(search || '').has('flick');
