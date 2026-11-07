// "Update required" (user, 2026-11-07): the phone app says its version when it connects, and an older one gets a
// small card with an Update button. /Novi.apk always serves the newest build on the laptop.
import fs from 'node:fs';

export function latestApp(file) {
  try {
    const { versionCode, versionName } = JSON.parse(fs.readFileSync(file, 'utf8')).elements[0];
    return Number.isFinite(versionCode) ? { code: versionCode, name: versionName } : null;
  } catch {
    return null; // no build on this laptop
  }
}

export function updateCard(reported, latest) {
  if (!latest || !Number.isFinite(reported) || reported >= latest.code) return null;
  return { key: 'app-update', title: 'Update required', body: `Novi ${latest.name} is ready. Tap Update to install it.`, link: '/Novi.apk' };
}
