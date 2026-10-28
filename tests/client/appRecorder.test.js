import { describe, it, expect } from 'vitest';
import { appBridge, startAppRecording, deliverAppAudio } from '../../src/lib/appRecorder.js';

// Inside the Novi Android app the page's own mic doesn't start (live 2026-10-28: "Microphone
// unavailable"), so the talk button asks the app to record and gets a WAV back.
describe('the app records for the talk button', () => {
  const fakeApp = () => {
    const calls = [];
    return { calls, record: (id) => calls.push(['record', id]), stop: (id) => calls.push(['stop', id]) };
  };

  it('is only used inside the app', () => {
    expect(appBridge({})).toBeNull();
    const app = fakeApp();
    expect(appBridge({ NoviApp: app })).toBe(app);
  });

  it('the app ends on a pause: the speech arrives as a WAV', async () => {
    const app = fakeApp();
    const auto = [];
    const rec = startAppRecording({ app, onAutoDone: (b) => auto.push(b) });
    const id = app.calls[0][1];
    deliverAppAudio(id, Buffer.from('RIFFdata').toString('base64'));
    await new Promise((r) => setTimeout(r, 0));
    expect(auto).toHaveLength(1);
    expect(auto[0].type).toBe('audio/wav');
    expect(Buffer.from(await auto[0].arrayBuffer()).toString()).toBe('RIFFdata');
    expect(await rec.finish()).toBe(auto[0]); // released after the pause: the same recording
  });

  it('a tap to finish stops the app; nothing said → nothing sent', async () => {
    const app = fakeApp();
    const auto = [];
    const rec = startAppRecording({ app, onAutoDone: (b) => auto.push(b) });
    const id = app.calls[0][1];
    const done = rec.finish();
    expect(app.calls).toEqual([['record', id], ['stop', id]]);
    deliverAppAudio(id, null);
    expect(await done).toBeNull();
    expect(auto).toEqual([]); // finished by the user, not by a pause
    expect(typeof rec.switchToTap).toBe('function');
  });
});
