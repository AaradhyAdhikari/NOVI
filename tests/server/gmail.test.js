import { describe, it, expect } from 'vitest';
import { GmailClient, extractBody, buildMime, encodeHeader, htmlToText } from '../../server/google/gmail.js';
import { UserFacingError } from '../../server/errors.js';

const b64 = (s) => Buffer.from(s).toString('base64url');
const headers = (h) => Object.entries(h).map(([name, value]) => ({ name, value }));
const meta = (id, from, subject, { unread = true, extra = {} } = {}) => ({
  id, threadId: `t${id}`, snippet: `snip &amp; ${id}`, labelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'],
  payload: { headers: headers({ From: from, Subject: subject, Date: 'Thu, 2 Oct 2026 10:00:00 +0530', ...extra }) },
});
const acct = { id: 'a1', email: 'me@gmail.com', label: 'personal' };

function client(routes) {
  const calls = [];
  let invalidated = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => String(url).includes(r.match) && (r.method || 'GET') === (init.method || 'GET'));
    if (!route) throw new Error(`no route for ${url}`);
    const out = typeof route.reply === 'function' ? route.reply(calls) : route.reply;
    return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200 });
  };
  const gmail = new GmailClient({ getToken: async () => 'tok', invalidate: () => { invalidated += 1; }, fetchImpl });
  return { gmail, calls, invalidated: () => invalidated };
}

describe('GmailClient.search', () => {
  it('lists messages with sender, subject, date, snippet and unread flag', async () => {
    const { gmail, calls } = client([
      { match: '/messages?q=', reply: { messages: [{ id: 'm1' }, { id: 'm2' }] } },
      { match: '/messages/m1?format=metadata', reply: meta('m1', 'Sir <sir@college.edu>', 'Class moved') },
      { match: '/messages/m2?format=metadata', reply: meta('m2', 'Amazon <a@amazon.in>', 'Order shipped', { unread: false }) },
    ]);
    const out = await gmail.search(acct, {});
    expect(calls[0].url).toContain(`q=${encodeURIComponent('in:inbox newer_than:7d')}`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(out).toEqual([
      { id: 'm1', threadId: 'tm1', from: 'Sir <sir@college.edu>', subject: 'Class moved', date: 'Thu, 2 Oct 2026 10:00:00 +0530', snippet: 'snip & m1', unread: true },
      { id: 'm2', threadId: 'tm2', from: 'Amazon <a@amazon.in>', subject: 'Order shipped', date: 'Thu, 2 Oct 2026 10:00:00 +0530', snippet: 'snip & m2', unread: false },
    ]);
  });

  it('returns nothing for an empty result', async () => {
    const { gmail } = client([{ match: '/messages?q=', reply: { resultSizeEstimate: 0 } }]);
    expect(await gmail.search(acct, { query: 'from:nobody' })).toEqual([]);
  });

  it('refreshes the token once on 401, then retries', async () => {
    const { gmail, invalidated } = client([
      { match: '/messages?q=', reply: (calls) => (calls.length === 1 ? { status: 401, body: {} } : { messages: [] }) },
    ]);
    expect(await gmail.search(acct, {})).toEqual([]);
    expect(invalidated()).toBe(1);
  });

  it('turns 403 into a spoken error', async () => {
    const { gmail } = client([{ match: '/messages?q=', reply: { status: 403, body: {} } }]);
    await expect(gmail.search(acct, {})).rejects.toThrow(UserFacingError);
    await expect(gmail.search(acct, {})).rejects.toThrow(/refused/);
  });
});

describe('GmailClient.read', () => {
  it('returns the plain-text part of a multipart email', async () => {
    const { gmail } = client([{
      match: '/messages/m1?format=full',
      reply: {
        id: 'm1', threadId: 'tm1', snippet: 'Hello', labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: headers({ From: 'Sir <sir@c.edu>', To: 'me@gmail.com', Subject: 'Class moved', Date: 'd' }),
          parts: [
            { mimeType: 'text/plain', filename: '', body: { data: b64('Hello ✓\r\nSee you') } },
            { mimeType: 'text/html', filename: '', body: { data: b64('<p>Hello</p>') } },
          ],
        },
      },
    }]);
    const m = await gmail.read(acct, 'm1');
    expect(m).toMatchObject({ id: 'm1', from: 'Sir <sir@c.edu>', to: 'me@gmail.com', subject: 'Class moved', body: 'Hello ✓\nSee you' });
  });
});

describe('body helpers', () => {
  it('converts HTML-only mail to text', () => {
    expect(htmlToText('<style>x{}</style><p>Hi&nbsp;there &amp; you</p>Bye')).toBe('Hi there & you\nBye');
    expect(extractBody({ mimeType: 'text/html', body: { data: b64('<div>A</div><div>B</div>') } })).toBe('A\nB');
  });

  it('skips attachments and caps very long bodies', () => {
    const payload = { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'x' } },
      { mimeType: 'text/plain', filename: '', body: { data: b64('x'.repeat(9000)) } },
    ] };
    const text = extractBody(payload);
    expect(text.length).toBeLessThan(8100);
    expect(text).toMatch(/email truncated/);
  });
});

describe('buildMime', () => {
  it('encodes non-ASCII subjects, blocks header injection, adds reply headers', () => {
    const raw = buildMime({ from: 'me@gmail.com', to: 'a@x.com\r\nBcc: evil@x.com', subject: 'Late — sorry', body: 'Hi ✓', inReplyTo: '<abc@mail>', references: '<abc@mail>' });
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const [head, body] = text.split('\r\n\r\n');
    expect(head).not.toMatch(/\r\nBcc:/);
    expect(head).toContain('To: a@x.com Bcc: evil@x.com');
    expect(head).toContain(`Subject: ${encodeHeader('Late — sorry')}`);
    expect(encodeHeader('Late — sorry')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeader('plain')).toBe('plain');
    expect(head).toContain('In-Reply-To: <abc@mail>');
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hi ✓');
  });
});

describe('GmailClient.send', () => {
  it('sends a new email from the account', async () => {
    const { gmail, calls } = client([{ match: '/messages/send', method: 'POST', reply: { id: 's1', threadId: 'ts1' } }]);
    expect(await gmail.send(acct, { to: 'sir@c.edu', subject: 'Late', body: 'Running late' })).toEqual({ id: 's1', threadId: 'ts1' });
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.threadId).toBeUndefined();
    const mime = Buffer.from(sent.raw, 'base64url').toString('utf8');
    expect(mime).toContain('From: me@gmail.com');
    expect(mime).toContain('Subject: Late');
  });

  it('replies in the original thread', async () => {
    const { gmail, calls } = client([
      { match: '/messages/m1?format=metadata', reply: meta('m1', 'Sir <sir@c.edu>', 'Class moved', { extra: { 'Message-ID': '<orig@c>' } }) },
      { match: '/messages/send', method: 'POST', reply: { id: 's2', threadId: 'tm1' } },
    ]);
    await gmail.send(acct, { to: 'sir@c.edu', subject: '', body: 'Thanks', replyTo: 'm1' });
    const sent = JSON.parse(calls.at(-1).init.body);
    expect(sent.threadId).toBe('tm1');
    const mime = Buffer.from(sent.raw, 'base64url').toString('utf8');
    expect(mime).toContain('Subject: Re: Class moved');
    expect(mime).toContain('In-Reply-To: <orig@c>');
  });
});
