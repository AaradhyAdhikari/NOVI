const NAMES = { google: 'Gmail', github: 'GitHub' };

// Which account a request means: named → that one; else the only one; else the default; else ask.
export function resolveAccount(registry, provider, requested, { allowAll = false } = {}) {
  const name = NAMES[provider] || provider;
  const accounts = registry.list(provider);
  if (!accounts.length) return { error: `No ${name} account is connected yet — say "connect my ${name}".` };
  const q = requested == null ? '' : String(requested).trim().toLowerCase();
  if (q) {
    if (q === 'all') return allowAll ? { accounts } : { error: `Tell me which ${name} account to use.` };
    const exact = accounts.find((a) => a.label === q || a.email === q);
    if (exact) return { account: exact };
    const partial = accounts.filter((a) => a.label.startsWith(q) || a.email.startsWith(q));
    if (partial.length === 1) return { account: partial[0] };
    return { error: `No ${name} account called "${requested}". Connected: ${accounts.map((a) => a.label).join(', ')}.` };
  }
  if (accounts.length === 1) return { account: accounts[0] };
  const def = registry.defaultFor(provider);
  if (def) return { account: def };
  return { ask: accounts.map(({ label, email }) => ({ label, email })) };
}

export function askNote(ask) {
  return `Which account: ${ask.map((a) => `${a.label} (${a.email})`).join(' or ')}?`;
}
