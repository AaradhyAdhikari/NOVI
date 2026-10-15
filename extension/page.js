// Injected into the page by the Novi extension. Builds the numbered page map Novi reads and does
// one action on a numbered item. Password fields: only whether they are empty leaves the page, and
// nothing is ever typed into them.
(() => {
  if (window.__novi) return;
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[contenteditable="true"],[role=button],[role=link],[role=textbox],[role=option],[role=tab],[role=checkbox],[role=menuitem],[role=combobox]';
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || el.value);
  const forms = new Map();
  const formId = (f) => (f ? (forms.has(f) ? forms.get(f) : (forms.set(f, f.id || `form${forms.size + 1}`), forms.get(f))) : null);
  const byN = (n) => document.querySelector(`[data-novi-n="${Number(n)}"]`);

  function read() {
    const items = [];
    let n = 0;
    let focused = null;
    for (const el of document.querySelectorAll(SEL)) {
      if (n >= 150 || !visible(el)) continue;
      n += 1;
      el.setAttribute('data-novi-n', String(n));
      const type = (el.getAttribute('type') || '').toLowerCase();
      const base = { n, tag: el.tagName.toLowerCase(), type, role: el.getAttribute('role') || '', label: labelOf(el), autocomplete: el.getAttribute('autocomplete') || '', form: formId(el.form), inForm: Boolean(el.form), disabled: Boolean(el.disabled) };
      if (type === 'password') items.push({ ...base, label: clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || 'Password'), empty: el.value === '' });
      else if (['input', 'textarea', 'select'].includes(base.tag)) items.push({ ...base, value: clean(el.value) });
      else items.push(base);
      if (el === document.activeElement) focused = n;
    }
    return { url: location.href, title: document.title, items, focused, text: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000), frames: [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean) };
  }

  function setValue(el, text) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const actions = {
    read,
    has: ({ selector }) => ({ found: Boolean(document.querySelector(selector)) }),
    click({ n }) {
      const el = byN(n);
      if (!el) return { error: 'That item is gone — the page changed.' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return {};
    },
    type({ n, text }) {
      const el = byN(n);
      if (!el) return { error: 'That item is gone — the page changed.' };
      if ((el.getAttribute('type') || '').toLowerCase() === 'password') return { error: "I don't type passwords. Type it on the laptop and say done." };
      el.focus();
      if (el.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('insertText', false, text); } else setValue(el, text);
      return {};
    },
    select({ n, option }) {
      const el = byN(n);
      if (!el || el.tagName !== 'SELECT') return { error: 'That is not a dropdown.' };
      const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === String(option).toLowerCase()) || [...el.options].find((o) => o.text.toLowerCase().includes(String(option).toLowerCase()));
      if (!opt) return { error: `No option called ${option}.` };
      setValue(el, opt.value);
      return {};
    },
    key({ key }) {
      const el = document.activeElement || document.body;
      if (key === 'Enter' && el.form) { el.form.requestSubmit(); return {}; }
      for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
      return {};
    },
    scroll({ dir }) { window.scrollBy(0, (dir === 'up' ? -0.8 : 0.8) * innerHeight); return {}; },
    attach({ selector, name, mime, b64 }) {
      const input = document.querySelector(selector || 'input[type=file]');
      if (!input) return { error: 'No file box on this page.' };
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mime || 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return {};
    },
  };
  window.__novi = actions;
})();
