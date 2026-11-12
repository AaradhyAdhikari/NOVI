// Injected into the page by the Novi extension. Builds the numbered page map Novi reads and does
// one action on a numbered item. Password fields: only whether they are empty leaves the page, and
// nothing is ever typed into them.
(() => {
  if (window.__novi) return;
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[contenteditable="true"],[role=button],[role=link],[role=textbox],[role=option],[role=tab],[role=checkbox],[role=menuitem],[role=combobox]';
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  // A chat page's message box: the biggest visible text box that isn't a password or a search field
  // (lower on the page wins a tie: chat boxes sit at the bottom).
  const chatBox = () => {
    // A real search field is skipped by what it is (type/role), not by its words: Perplexity's chat box is labelled
    // "Type / for search modes" (live 2026-11-12). Small panes make boxes narrow, so the size floor is low.
    const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible)
      .filter((el) => (el.getAttribute('type') || '').toLowerCase() !== 'password' && el.getAttribute('role') !== 'searchbox' && (el.getAttribute('type') || '').toLowerCase() !== 'search');
    const size = (el) => { const r = el.getBoundingClientRect(); return { area: r.width * r.height, y: r.top }; };
    return boxes.map((el) => ({ el, ...size(el) })).filter((b) => b.area > 2500).sort((a, b) => b.area - a.area || b.y - a.y)[0]?.el || null;
  };
  // The send button next to a message box: within a few parents, enabled, and saying send/submit/ask/go (in its
  // label or title), or a submit button.
  const sendButton = (box) => {
    let el = box;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      const hit = [...el.querySelectorAll('button, [role="button"]')].filter(visible).find((b) => !b.disabled && (b.getAttribute('type') === 'submit' || /\b(?:send|submit|ask|go|run)\b/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.innerText || ''}`)));
      if (hit) return hit;
    }
    return null;
  };
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
    // Links grouped under the heading above them (ChatGPT's sidebar: "Projects", "Pinned", "Recents").
    // A heading = a text-only element (no children, not inside a link) whose whole text matches one of `headings`.
    groups({ root = 'nav', headings = [], item = 'a[href]' }) {
      const box = document.querySelector(root);
      if (!box) return { groups: [] };
      const heads = headings.map((h) => new RegExp(h, 'i'));
      const out = [];
      let current = null;
      for (const el of box.querySelectorAll('*')) {
        if (el.matches(item)) {
          if (current && visible(el)) current.items.push({ text: clean(el.getAttribute('aria-label') || String(el.innerText || '').split('\n')[0]), href: el.getAttribute('href') });
          continue;
        }
        if (el.children.length || el.closest(item)) continue;
        const t = String(el.innerText || el.textContent || '').trim();
        if (t && t.length < 30 && heads.some((h) => h.test(t))) { current = { heading: t, items: [] }; out.push(current); }
      }
      return { groups: out };
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
      if (el.isContentEditable) {
        document.execCommand('selectAll', false);
        if (text) document.execCommand('insertText', false, text); else document.execCommand('delete', false);
        // Editors like Lexical (Perplexity) ignore execCommand; they take a typed-input event (live 2026-11-12).
        const has = () => String(el.innerText || '').replace(/\s+/g, ' ').trim().includes(String(text).replace(/\s+/g, ' ').trim().slice(0, 20));
        // The whole box selected first, so the words replace what's there (without it the editor dropped line breaks).
        if (text && !has()) {
          try { const sel = window.getSelection?.(); const r = document.createRange?.(); if (sel && r) { r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); } } catch { /* no selection API: the event alone */ }
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
        }
      } else setValue(el, text);
      return {};
    },
    scroll({ dir }) { window.scrollBy(0, (dir === 'up' ? -0.8 : 0.8) * innerHeight); return {}; },
    // New AIs join by themselves (2026-11-12): any chat page in general terms, no site list.
    // chatShape: only whether the page looks like a chat (a big message box and real text); never its words.
    chatShape() {
      const box = chatBox();
      return { chat: Boolean(box) && String(document.body?.innerText || '').length > 300 };
    },
    // chatAsk: the biggest message box gets the words (typed the way the page takes them), then the send
    // button next to it, or Enter.
    async chatAsk({ text }) {
      const box = chatBox();
      if (!box) return { sent: false, why: 'no message box' };
      box.focus();
      if (box.isContentEditable) {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, text);
        if (!String(box.innerText || '').includes(String(text).slice(0, 20))) {
          try { const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch { /* the event alone */ }
          box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
        }
      } else setValue(box, text);
      await new Promise((r) => setTimeout(r, 400));
      const near = sendButton(box);
      if (near) near.click();
      else for (const type of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return { sent: true };
    },
    // chatRead: the page's text and whether a "stop" button shows (still answering).
    chatRead() {
      const busy = [...document.querySelectorAll('button, [role="button"]')].filter(visible).some((b) => /\bstop\b/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.innerText || ''}`));
      return { text: String(document.body?.innerText || '').slice(-60000), busy };
    },
    // "Bring my work in" (2026-11-12): the page's main text and its big pictures (≥ 256 px, biggest first, ≤ 8),
    // on any site. Pictures only the page can read (blob:/data:) come back as data; the rest the extension fetches.
    async harvest() {
      const main = document.querySelector('main, [role="main"], article') || document.body;
      const text = String(main?.innerText || '').trim().slice(0, 20000);
      // A picture, not an icon: longer side ≥ 200 px, shorter ≥ 100 (live: Wikipedia's 300 px thumbnails were missed at 256 × 256).
      const big = (i) => Math.max(i.naturalWidth, i.naturalHeight) >= 200 && Math.min(i.naturalWidth, i.naturalHeight) >= 100;
      const imgs = [...document.images].filter(visible).filter(big)
        .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight).slice(0, 8);
      const images = [];
      for (const [i, img] of imgs.entries()) {
        const src = img.currentSrc || img.src;
        const item = { src, w: img.naturalWidth, h: img.naturalHeight, name: String(img.alt || `image-${i + 1}`).slice(0, 40) };
        if (/^(?:blob|data):/i.test(src)) {
          try {
            const blob = await (await fetch(src)).blob();
            item.mime = blob.type;
            item.b64 = await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(blob); });
          } catch { /* left out */ }
        }
        images.push(item);
      }
      return { url: location.href, title: document.title, text, images };
    },
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
