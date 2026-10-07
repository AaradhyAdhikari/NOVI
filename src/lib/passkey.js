// Phone side of fingerprint / face confirmation (WebAuthn passkeys via SimpleWebAuthn).
// The phone's own lock (finger, face) is checked by the phone; Novi only gets a signature.
const json = async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `server error ${res.status}`);
  return body;
};
const post = (api, url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

export async function registerPasskey(api) {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const optionsJSON = await json(await post(api, '/api/passkeys/register/options'));
  const response = await startRegistration({ optionsJSON });
  return json(await post(api, '/api/passkeys/register/verify', response));
}

// Returns the signed answer to send with the approval.
export async function confirmWithPasskey(api, approvalId) {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const optionsJSON = await json(await post(api, '/api/passkeys/auth/options', { approvalId }));
  return startAuthentication({ optionsJSON });
}
