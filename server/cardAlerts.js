// A waiting card as a notification (user, 2026-10-28: "the popup should come on my phone … and the
// laptop"): the short task, one line, and at most two buttons. Used for phone push (public/sw.js) and the
// laptop's Windows notification (the Novi Chrome extension). Never the card's detail (commands, paths).
const cut = (s, max = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export function cardAlert(a) {
  if (a.question) {
    const options = a.question.options || [];
    return {
      id: a.id,
      title: cut(a.title || `Claude asks: ${a.question.text}`),
      body: `${options.length ? `Options: ${options.map((o) => o.label).join(', ')}. ` : ''}Tap to answer in Novi.`,
      actions: options.slice(0, 2).map((o, i) => ({ action: `opt:${i}`, title: cut(o.label, 30) })),
    };
  }
  if (a.choices?.length) {
    return { id: a.id, title: cut(a.prompt || a.title), body: 'Tap to open Novi.', actions: a.choices.slice(0, 2).map((c) => ({ action: `choice:${c.id}`, title: cut(c.label, 30) })) };
  }
  // High risk, deletes, dangerous commands: Approve opens Novi for the PIN (or fingerprint).
  const proof = a.tier === 'high' || a.pin || a.kind;
  return {
    id: a.id,
    title: cut(a.tier === 'high' ? `High risk: ${a.title}` : a.title),
    proof: Boolean(proof),
    body: proof ? 'Approving needs your PIN. Tap to open Novi.' : 'Tap to open Novi.',
    actions: [{ action: 'approve', title: proof ? 'Approve (PIN)' : 'Approve' }, { action: 'deny', title: 'Deny' }],
  };
}
