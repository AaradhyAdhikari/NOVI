// GitHub REST client and OAuth device flow (no client secret needed).
const API = 'https://api.github.com';
const FORM = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
const EXPIRED_CODE = 'The GitHub code expired. Say "connect my GitHub" to get a new one.';

export const GITHUB_SCOPES = 'repo notifications read:user';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export async function startDeviceFlow({ clientId, fetchImpl = fetch }) {
  const res = await fetchImpl('https://github.com/login/device/code', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ client_id: clientId, scope: GITHUB_SCOPES }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.device_code) throw new Error(`GitHub sign-in could not start (${json.error_description || json.error || res.status}).`);
  return json; // { device_code, user_code, verification_uri, expires_in, interval }
}

export async function pollForToken({ clientId, deviceCode, interval = 5, expiresIn = 900, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const deadline = now() + expiresIn * 1000;
  let wait = interval;
  while (now() < deadline) {
    await sleep(wait * 1000);
    const res = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (json.access_token) return { token: json.access_token, scope: json.scope || '' };
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      wait = json.interval || wait + 5;
      continue;
    }
    if (json.error === 'access_denied') throw new Error('The GitHub connection was cancelled.');
    if (json.error === 'expired_token') throw new Error(EXPIRED_CODE);
    throw new Error(`GitHub sign-in failed (${json.error || res.status}).`);
  }
  throw new Error(EXPIRED_CODE);
}

export class GitHubClient {
  constructor({ token, fetchImpl = fetch }) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body) {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Novi',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 202 || res.status === 204 || res.status === 205) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GitHubError(res.status, json.message || `GitHub error ${res.status}`);
    return json;
  }
}
