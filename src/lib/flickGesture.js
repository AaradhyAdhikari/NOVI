// Novi Flick, phone side: what counts as a flick, and the request that sends an item to the laptop.
export function isFlick({ dy, ms }) {
  if (dy >= 0) return false;
  if (dy <= -110) return true;
  return dy <= -40 && -dy / Math.max(ms, 1) >= 0.6; // short but fast
}

// The real flick (v2): a quick forward flick of the wrist, phone toward the laptop. Samples: { t (ms), acc
// (m/s², gravity removed), rx, ry, rz (rotation, degrees/s; x = the phone's short side, the pitch of a flick) }.
// It fires when, within 300 ms, the phone both jolts (≥ 14 m/s²) and pitches hard (≥ 240°/s, mostly about x),
// right after being held fairly still. Walking, a bump on the table, a twist and an ongoing shake don't count;
// one flick per 1.5 s. The same numbers are in the Android app (FlickDetector.kt).
export const FLICK = { minAcc: 14, minRot: 240, axisRatio: 1.4, calmAcc: 4, calmMs: 300, windowMs: 300, cooldownMs: 1500 };
export function createFlickDetector(opts = {}) {
  const o = { ...FLICK, ...opts };
  let buf = [];
  let last = -Infinity;
  return {
    feed({ t, acc = 0, rx = 0, ry = 0, rz = 0 }) {
      buf.push({ t, acc: Math.abs(acc), rx: Math.abs(rx), ry: Math.abs(ry), rz: Math.abs(rz) });
      buf = buf.filter((s) => t - s.t <= o.windowMs + o.calmMs + 200);
      if (t - last < o.cooldownMs) return false;
      const win = buf.filter((s) => t - s.t <= o.windowMs);
      const before = buf.filter((s) => t - s.t > o.windowMs && t - s.t <= o.windowMs + o.calmMs);
      const peak = (k) => Math.max(0, ...win.map((s) => s[k]));
      const jolt = peak('acc'), pitch = peak('rx'), other = Math.max(peak('ry'), peak('rz'));
      const calm = before.length >= 3 && before.every((s) => s.acc < o.calmAcc);
      if (jolt >= o.minAcc && pitch >= o.minRot && pitch >= o.axisRatio * other && calm) { last = t; buf = []; return true; }
      return false;
    },
  };
}

// A browser DeviceMotionEvent → one detector sample (rotationRate is in degrees/s; beta = about x).
export function motionSample(e, t = performance.now()) {
  const a = e.acceleration;
  let acc = 0;
  if (a && a.x != null) acc = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  else if (e.accelerationIncludingGravity) { const g = e.accelerationIncludingGravity; acc = Math.abs(Math.hypot(g.x || 0, g.y || 0, g.z || 0) - 9.81); }
  const r = e.rotationRate || {};
  return { t, acc, rx: r.beta || 0, ry: r.gamma || 0, rz: r.alpha || 0 };
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
