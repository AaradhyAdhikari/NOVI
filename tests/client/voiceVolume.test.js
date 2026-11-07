import { describe, it, expect } from 'vitest';
import { appVolume, appMayTalk } from '../../src/lib/appRecorder.js';

// User, 2026-11-07: "novi's voice is too loud, let the user fix the volume". The app's own setting also sets the
// page's voice, so both sound the same.
describe("Novi's voice volume on the page", () => {
  it('uses the volume set in the phone app', () => {
    expect(appVolume({ voiceVolume: () => 0.4 })).toBe(0.4);
  });
  it('full volume in a plain browser', () => {
    expect(appVolume(undefined)).toBe(1);
    expect(appVolume({})).toBe(1);
  });
  it('an odd value never breaks speech', () => {
    expect(appVolume({ voiceVolume: () => 7 })).toBe(1);
    expect(appVolume({ voiceVolume: () => -1 })).toBe(0.1);
    expect(appVolume({ voiceVolume: () => { throw new Error('gone'); } })).toBe(1);
  });
});

// Earbuds-only: with no earbuds in, the page inside the app stays silent too.
describe('whether the page may speak', () => {
  it('follows the phone app', () => {
    expect(appMayTalk({ mayTalk: () => false })).toBe(false);
    expect(appMayTalk({ mayTalk: () => true })).toBe(true);
  });
  it('a plain browser, or an older app, speaks as before', () => {
    expect(appMayTalk(undefined)).toBe(true);
    expect(appMayTalk({})).toBe(true);
    expect(appMayTalk({ mayTalk: () => { throw new Error('gone'); } })).toBe(true);
  });
});
