// Spoken lines meant for a phone that didn't have Novi open (last `max` per phone, in memory).
// The phone plays them, in order, the next time it opens Novi.
export function createMissedQueue({ max = 20 } = {}) {
  const lines = new Map();
  return {
    add(deviceId, text) {
      const list = [...(lines.get(deviceId) || []), String(text)].slice(-max);
      lines.set(deviceId, list);
    },
    take(deviceId) {
      const list = lines.get(deviceId) || [];
      lines.delete(deviceId);
      return list;
    },
    clear(deviceId) {
      lines.delete(deviceId);
    },
  };
}
