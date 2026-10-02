import { UserFacingError } from '../errors.js';
import { resolveAccount, askNote } from '../accounts/resolve.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const SERVICES = { gmail: 'google', google: 'google', email: 'google' };
const ACCOUNT = str('Account label or email (e.g. "college"); omit to use the default or the only one');

const expiredMessage = (a) => `Your ${a.label} Gmail connection expired — reconnect it in Settings.`;

function pick(accounts, requested, opts) {
  const r = resolveAccount(accounts, 'google', requested, opts);
  if (r.error) throw new UserFacingError(r.error);
  return r;
}

function usable(account) {
  if (account.status === 'expired') throw new UserFacingError(expiredMessage(account));
  return account;
}

export function addAccountTools(registry, { accounts, auth, gmail, onConnected = () => {}, onConnectError = () => {} }) {
  return registry
    .add({
      name: 'accounts_list',
      description: 'List connected accounts (Gmail): labels, emails, which one is the default, and whether any expired.',
      parameters: obj(),
      tier: 'low',
      describe: () => 'List accounts',
      run: async () => ({
        accounts: accounts.list().map((a) => ({ service: a.provider === 'google' ? 'gmail' : a.provider, label: a.label, email: a.email, status: a.status, default: accounts.defaultFor(a.provider)?.id === a.id })),
      }),
    })
    .add({
      name: 'accounts_set_default',
      description: 'Set which account Novi uses by default for a service, or clear it (account "none") so Novi asks each time.',
      parameters: obj({ service: str('Service, e.g. "gmail"'), account: str('Account label or email, or "none" to clear') }, ['account']),
      tier: 'low',
      describe: ({ account }) => `Default account: ${account}`,
      run: async ({ service = 'gmail', account }) => {
        const provider = SERVICES[String(service).toLowerCase()] || 'google';
        if (!account || /^(none|clear|no default|nobody)$/i.test(String(account).trim())) {
          accounts.setDefault(provider, null);
          return { default: null };
        }
        const { account: chosen } = pick(accounts, account);
        accounts.setDefault(provider, chosen.id);
        return { default: chosen.label };
      },
    })
    .add({
      name: 'accounts_rename',
      description: 'Rename a connected account (its label), e.g. call c@college.edu "college".',
      parameters: obj({ account: str('Current label or email'), label: str('New label') }, ['account', 'label']),
      tier: 'low',
      describe: ({ account, label }) => `Rename ${account} to ${label}`,
      run: async ({ account, label }) => {
        const { account: target } = pick(accounts, account);
        return { renamed: accounts.setLabel(target.id, label).label };
      },
    })
    .add({
      name: 'gmail_connect',
      description: "Connect a Gmail account: opens Google's sign-in page on the laptop, where the user picks the account and allows Novi.",
      parameters: obj(),
      tier: 'low',
      describe: () => 'Connect Gmail',
      run: async () => {
        const { done } = await auth.connect();
        done.then(onConnected, onConnectError);
        return { note: "I've opened Google's sign-in page on the laptop. Pick the account and allow Novi; I'll tell you when it's connected." };
      },
    })
    .add({
      name: 'gmail_search',
      description: 'Search Gmail. query uses Gmail search syntax (from:, to:, subject:, is:unread, newer_than:2d); default is the last 7 days of the inbox. account "all" searches every connected account.',
      parameters: obj({ query: str('Gmail search query'), account: str('Account label/email, "all", or omit'), max: { type: 'integer', description: 'Max results per account (default 10, max 25)' } }),
      tier: 'low',
      describe: ({ query }) => `Search Gmail${query ? ` for ${query}` : ''}`,
      run: async ({ query, account, max }) => {
        const r = pick(accounts, account, { allowAll: true });
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        const targets = (r.accounts || [r.account]).map(usable);
        const messages = [];
        for (const acc of targets) {
          for (const m of await gmail.search(acc, { query, max: max || 10 })) messages.push({ account: acc.label, ...m });
        }
        return { sensitive: true, query: query || 'in:inbox newer_than:7d', messages };
      },
    })
    .add({
      name: 'gmail_read',
      description: 'Read one email in full (use an id from gmail_search, with the same account).',
      parameters: obj({ id: str('Message id from gmail_search'), account: ACCOUNT }, ['id']),
      tier: 'low',
      describe: () => 'Read an email',
      run: async ({ id, account }) => {
        const r = pick(accounts, account);
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        const acc = usable(r.account);
        return { sensitive: true, account: acc.label, message: await gmail.read(acc, id) };
      },
    })
    .add({
      name: 'gmail_send',
      description: "Send an email, or reply when reply_to_id is given (keeps the thread). Write the complete email; the user sees it with the sending account and must approve it. Never guess addresses — ask.",
      parameters: obj({
        to: str('Recipient email address(es), comma-separated'),
        subject: str('Subject (for replies it can be empty)'),
        body: str('Complete plain-text email body'),
        cc: str('Cc addresses, optional'),
        reply_to_id: str('Message id being replied to, optional'),
        account: ACCOUNT,
      }, ['to', 'body']),
      tier: 'medium',
      precheck: async ({ account }) => {
        const r = resolveAccount(accounts, 'google', account);
        if (r.error) return { error: r.error, note: r.error };
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        if (r.account.status === 'expired') return { error: expiredMessage(r.account), note: expiredMessage(r.account) };
        return null;
      },
      describe: ({ account, to, subject }) => {
        const a = resolveAccount(accounts, 'google', account).account;
        return `Send from ${a ? `${a.label} (${a.email})` : 'Gmail'} to ${to}${subject ? `: ${subject}` : ''}`;
      },
      detail: ({ cc, body }) => `${cc ? `Cc: ${cc}\n\n` : ''}${body ?? ''}`,
      run: async ({ to, subject, body, cc, reply_to_id: replyTo, account }) => {
        const acc = usable(pick(accounts, account).account);
        const sent = await gmail.send(acc, { to, cc, subject, body, replyTo });
        return { sent: true, from: acc.label, to, id: sent.id };
      },
    });
}
