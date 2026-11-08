// Is this open page older than the page code Novi serves now? (server/uiBuild.js) `mine` = this page's main
// script address; `reloadedFor` = the build this page already reloaded for, so a cached copy can't loop.
export function staleUi(served, mine, reloadedFor) {
  if (!served || !mine || served === reloadedFor) return false;
  const name = String(mine).split('/').pop();
  return /^index-[\w-]+\.js$/.test(name) && name !== served;
}

export function myScript(doc = globalThis.document) {
  return doc?.querySelector?.('script[type="module"][src*="/assets/index-"]')?.src || '';
}
