// What a card asks for before Allow, in the page. Inside the phone app with fingerprint set up (2026-11-11),
// every proof (PIN, passkey, "at the laptop") becomes the fingerprint: the laptop refuses the PIN alone from
// that phone anyway (server/remoteTrust.js).
export function proofKind(card, hasFingerprint) {
  const need = card?.need || (card?.pin ? 'pin' : null);
  if (!need) return null;
  if (hasFingerprint && ['pin', 'passkey', 'laptop', 'fingerprint'].includes(need)) return 'fingerprint';
  return need;
}

// The phone app's bridge (android MainActivity.Bridge): fingerprint set up on this phone?
export const appFingerprint = () => {
  try { return Boolean(window.NoviApp?.hasFingerprint?.()); } catch { return false; }
};
export const askAppFingerprint = (id, title) => {
  try { window.NoviApp?.fingerprint?.(String(id), String(title || '')); return true; } catch { return false; }
};
