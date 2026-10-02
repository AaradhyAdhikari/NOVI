// localStorage can throw (private mode, blocked storage); never let it break the app.
export function getItem(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function setItem(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* ignore */ }
}
