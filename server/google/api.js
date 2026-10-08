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
          // raw: a file upload (e.g. a Drive backup) sent as-is with its own content type.
          const { raw, headers = {}, ...rest } = init;
          const type = raw ? {} : init.body ? { 'Content-Type': 'application/json' } : {};
          res = await fetchImpl(url, { ...rest, headers: { Authorization: `Bearer ${token}`, ...type, ...headers }, signal: AbortSignal.timeout(raw ? 120_000 : 20_000) });
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
          const which = /tasks/i.test(url) ? 'Google Tasks API' : /calendar/i.test(url) ? 'Google Calendar API' : /sheets\.googleapis/i.test(url) ? 'Google Sheets API' : /\/drive\//i.test(url) ? 'Google Drive API' : 'Google API';
          throw new UserFacingError(`First turn on the ${which} for Novi's Google Cloud project (APIs & Services → Library → ${which} → Enable), then try again.`);
        }
        if (res.status === 403) throw new UserFacingError("Google said Novi isn't allowed to do that. Reconnect Google in Settings and tick all the permissions it asks for (Calendar, Tasks, Drive files).");
        throw new UserFacingError(`Google returned an error (${res.status}).`);
      }
    },
  };
}
