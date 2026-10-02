import { UserFacingError } from '../errors.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 8000;
const DEFAULT_QUERY = 'in:inbox newer_than:7d';

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decodeEntities = (s) => String(s || '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => {
  if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return m;
});

export function htmlToText(html) {
  const text = decodeEntities(String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  return lines.filter((l, i) => l || (i > 0 && lines[i - 1])).join('\n').trim();
}

const decode = (data) => Buffer.from(String(data || ''), 'base64url').toString('utf8');

export function extractBody(payload) {
  const found = {};
  (function walk(part) {
    if (!part) return;
    const isAttachment = Boolean(part.filename);
    if (!isAttachment && part.body?.data) {
      if (part.mimeType === 'text/plain' && found.plain === undefined) found.plain = decode(part.body.data);
      if (part.mimeType === 'text/html' && found.html === undefined) found.html = decode(part.body.data);
    }
    for (const p of part.parts || []) walk(p);
  })(payload);
  let text = (found.plain !== undefined ? found.plain : htmlToText(found.html || '')).replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY)}\n… (email truncated)`;
  return text;
}

export function header(message, name) {
  const h = (message?.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function summarize(m) {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, 'From'),
    subject: header(m, 'Subject') || '(no subject)',
    date: header(m, 'Date'),
    snippet: decodeEntities(m.snippet || ''),
    unread: (m.labelIds || []).includes('UNREAD'),
  };
}

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

export function encodeHeader(s) {
  const v = clean(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

export function buildMime({ from, to, cc, subject, body, inReplyTo, references }) {
  const lines = [`From: ${clean(from)}`, `To: ${clean(to)}`];
  if (cc) lines.push(`Cc: ${clean(cc)}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${clean(inReplyTo)}`, `References: ${clean(references || inReplyTo)}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
  lines.push(Buffer.from(String(body ?? ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function gmailError(status) {
  if (status === 401) return "Gmail rejected Novi's access — reconnect this account in Settings.";
  if (status === 403) return 'Gmail refused that request (permission or quota).';
  if (status === 404) return "I couldn't find that email.";
  if (status === 429) return 'Gmail is rate-limiting Novi; try again in a minute.';
  return `Gmail had a problem (${status}).`;
}

export class GmailClient {
  constructor({ getToken, invalidate = () => {}, fetchImpl = fetch }) {
    this.getToken = getToken;
    this.invalidate = invalidate;
    this.fetchImpl = fetchImpl;
  }

  async _call(account, pathAndQuery, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(account);
      let res;
      try {
        res = await this.fetchImpl(`${API}${pathAndQuery}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new UserFacingError(`I couldn't reach Gmail: ${err.message}`);
      }
      if (res.status === 401 && attempt === 0) {
        this.invalidate(account);
        continue;
      }
      if (!res.ok) throw new UserFacingError(gmailError(res.status));
      return res.json();
    }
  }

  async search(account, { query = DEFAULT_QUERY, max = 10 } = {}) {
    const q = query || DEFAULT_QUERY;
    const list = await this._call(account, `/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(Math.max(Number(max) || 10, 1), 25)}`);
    const ids = (list.messages || []).map((m) => m.id);
    const fields = ['From', 'To', 'Subject', 'Date'].map((h) => `metadataHeaders=${h}`).join('&');
    const metas = await Promise.all(ids.map((id) => this._call(account, `/messages/${encodeURIComponent(id)}?format=metadata&${fields}`)));
    return metas.map(summarize);
  }

  async read(account, id) {
    const m = await this._call(account, `/messages/${encodeURIComponent(id)}?format=full`);
    return { ...summarize(m), to: header(m, 'To'), cc: header(m, 'Cc'), body: extractBody(m.payload) };
  }

  async send(account, { to, cc, subject, body, replyTo }) {
    let threadId;
    let inReplyTo;
    let references;
    let finalSubject = subject;
    if (replyTo) {
      const fields = ['Message-ID', 'Subject', 'References'].map((h) => `metadataHeaders=${h}`).join('&');
      const orig = await this._call(account, `/messages/${encodeURIComponent(replyTo)}?format=metadata&${fields}`);
      threadId = orig.threadId;
      inReplyTo = header(orig, 'Message-ID');
      references = [header(orig, 'References'), inReplyTo].filter(Boolean).join(' ');
      const base = finalSubject || header(orig, 'Subject') || '';
      finalSubject = /^re:/i.test(base) ? base : `Re: ${base}`;
    }
    const raw = buildMime({ from: account.email, to, cc, subject: finalSubject, body, inReplyTo, references });
    const sent = await this._call(account, '/messages/send', { method: 'POST', body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
    return { id: sent.id, threadId: sent.threadId };
  }
}
