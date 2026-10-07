import { UserFacingError } from '../errors.js';
import { resolveAccount } from '../accounts/resolve.js';

// Signed-in calls to Google APIs for plugins (api.runtime.google): Calendar, Tasks, ...
export function createGoogleApi({ auth, accounts, fetchImpl = fetch }) {
  return {
    get configured() { return Boolean(auth?.configured); },
    resolve: (requested) => resolveAccount(accounts, 'google', requested),
    async call(account, url, init = {}) {
      for (let attempt = 0; ; attempt++) {
        const token = await auth.accessToken(account);
        let res;
        try {
          res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(20_000) });
        } catch (err) {
          throw new UserFacingError(`I couldn't reach Google: ${err.message}`);
        }
        if (res.status === 401 && attempt === 0) {
          auth.invalidate(account.id);
          continue;
        }
        const body = await res.json().catch(() => ({}));
        if (res.ok) return body;
        const msg = String(body.error?.message || '');
        const disabled = /has not been used|is disabled|SERVICE_DISABLED/i.exec(msg);
        if (disabled) {
          const which = /tasks/i.test(url) ? 'Google Tasks API' : /calendar/i.test(url) ? 'Google Calendar API' : 'Google API';
          throw new UserFacingError(`First turn on the ${which} for Novi's Google Cloud project (APIs & Services → Library → ${which} → Enable), then try again.`);
        }
        if (res.status === 403) throw new UserFacingError("Google said Novi isn't allowed to do that. Reconnect Google in Settings and tick the Calendar and Tasks permissions.");
        throw new UserFacingError(`Google returned an error (${res.status}).`);
      }
    },
  };
}
