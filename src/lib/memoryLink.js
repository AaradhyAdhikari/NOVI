// A link straight to the memory graph (user, 2026-11-05: "show me, give me link"): <Novi>/?memory
export function wantsMemory(search) {
  return new URLSearchParams(search || '').has('memory');
}
