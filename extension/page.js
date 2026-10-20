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
    // Old numbers go first: an element hidden since the last read must not answer to a new number.
    for (const el of document.querySelectorAll('[data-novi-n]')) el.removeAttribute('data-novi-n');
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
    // Generic helpers by CSS selector (WhatsApp Web's spots come from Novi, so a page change is fixed in Novi).
    // The whole text of the last visible match, line breaks kept (an AI site's newest answer).
    textOf({ selector }) {
      const all = [...document.querySelectorAll(selector)].filter(visible);
      return { count: all.length, text: all.length ? String(all.at(-1).innerText || '').trim().slice(0, 20000) : '' };
    },
    // Every visible match, whole (line breaks kept), with one attribute each (a chat: who wrote each message);
    // `attrs` = several attributes each (ChatGPT marks your messages and its own with different ones).
    textsOf({ selector, attr = null, attrs = null }) {
      const all = [...document.querySelectorAll(selector)].filter(visible);
      return { items: all.slice(-500).map((el) => ({
        text: String(el.innerText || '').trim().slice(0, 50000),
        attr: attr ? el.getAttribute(attr) : null,
        ...(attrs ? { attrs: Object.fromEntries(attrs.map((a) => [a, el.getAttribute(a)])) } : {}),
      })) };
    },
    // firstLine: a card's name (its first line); attr: that attribute of each match too (a link's href).
    // scrollLast: show the last match, so a list that loads more as you scroll (claude.ai) shows more.
    query({ selector, firstLine = false, attr = null, scrollLast = false }) {
      const els = [...document.querySelectorAll(selector)].filter(visible);
      if (scrollLast && els.length) els[els.length - 1].scrollIntoView({ block: 'end' });
      const text = (el) => (firstLine ? String(el.innerText || '').split('\n').map((l) => l.trim()).find(Boolean) || '' : el.getAttribute('title') || el.innerText);
      return { texts: els.map((el) => clean(text(el))), ...(attr ? { values: els.map((el) => el.getAttribute(attr) || '') } : {}) };
    },
    clickSel({ selector, text }) {
      const el = [...document.querySelectorAll(selector)].filter(visible).find((x) => !text || clean(x.getAttribute('title') || x.innerText).toLowerCase() === String(text).toLowerCase());
      if (!el) return { error: 'I could not find that on the page.' };
      el.scrollIntoView({ block: 'center' });
      (el.closest('[role=listitem],[role=row],button,[role=button]') || el).click();
      return {};
    },
    typeSel({ selector, text }) {
      const el = [...document.querySelectorAll(selector)].find(visible);
      if (!el) return { error: 'I could not find the box to type in.' };
      if ((el.getAttribute('type') || '').toLowerCase() === 'password') return { error: "I don't type passwords. Type it on the laptop and say done." };
      el.focus();
      if (el.isContentEditable) { document.execCommand('selectAll', false); if (text) document.execCommand('insertText', false, text); else document.execCommand('delete', false); } else setValue(el, text);
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
