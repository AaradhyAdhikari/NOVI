// A card flicked from the phone opens in its own window on the laptop (user, 2026-11-19: "open a new window where
// that card lands … see the changes … the whole code of that changed file"): Novi's page with ?cardview=<id>
// shows only that card, its first changed file open as the whole code with the changes marked.
export function cardViewId(search) {
  const id = new URLSearchParams(search || '').get('cardview');
  return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}
export const inCardWindow = () => typeof window !== 'undefined' && cardViewId(window.location.search) !== null;
