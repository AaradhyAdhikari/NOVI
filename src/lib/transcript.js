// The server keeps only text in its transcript (pictures are too big to resend on every refresh),
// so a refreshed list keeps the pictures, videos and links this page already received.
const EXTRAS = ['image', 'video', 'link'];
const key = (e) => `${e.at}|${e.role}|${e.text}`;

export function mergeTranscript(shown, fromServer) {
  if (!fromServer) return shown;
  const had = new Map(shown.filter((e) => EXTRAS.some((k) => e[k])).map((e) => [key(e), e]));
  return fromServer.map((e) => {
    const old = had.get(key(e));
    if (!old) return e;
    const extra = {};
    for (const k of EXTRAS) if (old[k] && !e[k]) extra[k] = old[k];
    return { ...e, ...extra };
  });
}
