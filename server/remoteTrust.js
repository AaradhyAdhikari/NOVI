// What a phone must prove before it may allow an approval (spec: remote access, "Remote trust rules").
// The laptop itself ('local') answers as before. Denials never need proof.
//   delete / payment → passkey (fingerprint / face); no passkey on that phone → only at the laptop
//   high risk        → voice PIN
//   anything else    → nothing extra
export const PROOF_KINDS = new Set(['delete', 'payment']);

export function requiredProof(approval, from, { hasPasskey = false } = {}) {
  if (from === 'local') return null;
  if (PROOF_KINDS.has(approval.kind)) return hasPasskey ? 'passkey' : 'laptop';
  if (approval.tier === 'high') return 'pin';
  return null;
}

// verifiers: { pin(proof, from) -> boolean, passkey(proof, from, approval) -> boolean, hasPasskey(from) -> boolean }.
// Missing verifiers mean that proof can't be given yet (refused).
export function createRemoteTrust(verifiers = {}) {
  return {
    check(approval, from, proof) {
      const need = requiredProof(approval, from, { hasPasskey: Boolean(from !== 'local' && verifiers.hasPasskey?.(from)) });
      if (!need) return { ok: true };
      if (need === 'pin' && proof?.pin !== undefined && verifiers.pin?.(proof, from)) return { ok: true };
      if (need === 'passkey' && proof?.passkey !== undefined && verifiers.passkey?.(proof, from, approval)) return { ok: true };
      return { ok: false, need };
    },
  };
}
