import { describe, it, expect } from 'vitest';
import { findWindows, workWindow, isNovi, appLabel } from '../../plugins/laptop-control/windows.js';

const NOVI = { id: 1, title: 'Novi - Google Chrome', process: 'chrome' };
const WA = { id: 2, title: 'WhatsApp', process: 'WhatsApp' };
const GMAIL = { id: 3, title: 'Inbox - Gmail - Google Chrome', process: 'chrome' };
const CODE = { id: 4, title: 'main.js - NOVI - Visual Studio Code', process: 'Code' };
const EXPL = { id: 5, title: 'ドキュメント', process: 'explorer' };
const list = [NOVI, WA, GMAIL, CODE, EXPL];

describe('window names', () => {
  it('finds apps by alias, name, title, and small typos; front-most first', () => {
    expect(findWindows(list, 'chrome')).toEqual([GMAIL]);
    expect(findWindows(list, 'Google Chrome')).toEqual([GMAIL]);
    for (const n of ['vs code', 'vscode', 'code', 'Visual Studio Code']) expect(findWindows(list, n), n).toEqual([CODE]);
    expect(findWindows(list, 'whatsap')).toEqual([WA]);
    expect(findWindows(list, 'WhatsApp')).toEqual([WA]);
    expect(findWindows(list, 'file explorer')).toEqual([EXPL]);
    expect(findWindows(list, 'gmail')).toEqual([GMAIL]);
    const two = [{ ...GMAIL, id: 9 }, GMAIL];
    expect(findWindows(two, 'chrome').map((w) => w.id)).toEqual([9, 3]);
  });

  it('never picks Novi or an unknown app', () => {
    expect(findWindows(list, 'novi')).toEqual([]);
    expect(findWindows(list, 'zoom')).toEqual([]);
    expect(findWindows(list, '')).toEqual([]);
    expect(isNovi(NOVI)).toBe(true);
    expect(isNovi(CODE)).toBe(false); // "NOVI" in a VS Code title is the project, not Novi's page
  });

  it('the work window is the front-most one that is not Novi', () => {
    expect(workWindow(list)).toEqual(WA);
    expect(workWindow([GMAIL, NOVI])).toEqual(GMAIL);
    expect(workWindow([NOVI])).toBe(null);
  });

  it('names apps the way people say them', () => {
    expect(appLabel(GMAIL)).toBe('Chrome');
    expect(appLabel(CODE)).toBe('VS Code');
    expect(appLabel(WA)).toBe('WhatsApp');
    expect(appLabel({ id: 7, title: 'x', process: 'Spotify' })).toBe('Spotify');
  });
});
