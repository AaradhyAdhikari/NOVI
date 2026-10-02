import { describe, it, expect } from 'vitest';
import { toUrl } from '../../server/laptop/opener.js';
import { parseYouTubeResults, searchYouTube, watchUrl, searchUrl } from '../../server/laptop/youtube.js';
import { parseStartApps, matchApps, resolveApp } from '../../server/laptop/apps.js';
import { addLaptopTools } from '../../server/laptop/laptopTools.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import { UserFacingError } from '../../server/errors.js';

const ytPage = (videos) => `<html><script>var ytInitialData = ${JSON.stringify({
  contents: { list: { items: [
    { adSlotRenderer: { id: 'ad' } },
    ...videos.map(([videoId, title, channel, length]) => ({
      videoRenderer: { videoId, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: channel }] }, ...(length ? { lengthText: { simpleText: length } } : {}) },
    })),
  ] } },
})};</script></html>`;

const LOFI = [
  ['v1', 'Study Session', 'Lofi Girl', '1:01:14'],
  ['v2', 'Best of lofi 2021', 'Lofi Girl', '6:10:58'],
  ['v3', 'lofi radio', 'Lofi Girl', null],
  ['v4', 'lofi mix part 1', 'Lofi Girl', '2:50:41'],
  ['v5', 'Chill Lofi Mix', 'Settle', '1:44:52'],
  ['v6', 'Best of lofi 2022', 'Lofi Girl', '3:11:14'],
];

const APPS = [
  { name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { name: 'Google Chrome', appId: 'Chrome' },
  { name: 'CodeBlocks', appId: '{X}\\CodeBlocks\\codeblocks.exe' },
  { name: 'CodeBlocks (Launcher)', appId: '{X}\\CodeBlocks\\CbLauncher.exe' },
  { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
];

describe('toUrl', () => {
  it('keeps full web links', () => {
    expect(toUrl('https://github.com')).toBe('https://github.com/');
  });
  it('adds https to bare domains', () => {
    expect(toUrl('leetcode.com/problems')).toBe('https://leetcode.com/problems');
  });
  it('turns plain phrases into a Google search', () => {
    expect(toUrl('best pizza near me')).toBe('https://www.google.com/search?q=best%20pizza%20near%20me');
  });
  it('refuses non-web links', () => {
    expect(() => toUrl('file:///C:/Windows/system32')).toThrow(UserFacingError);
    expect(() => toUrl('javascript:alert(1)')).toThrow(/web/);
  });
  it('refuses direct downloads', () => {
    expect(() => toUrl('https://x.com/setup.exe')).toThrow(/download/);
    expect(() => toUrl('https://x.com/files/archive.zip?x=1')).toThrow(/download/);
  });
});

describe('parseYouTubeResults', () => {
  it('returns numbered videos, skipping ads, marking live streams', () => {
    const results = parseYouTubeResults(ytPage(LOFI));
    expect(results).toHaveLength(6);
    expect(results[0]).toEqual({ position: 1, videoId: 'v1', title: 'Study Session', channel: 'Lofi Girl', length: '1:01:14' });
    expect(results[2].length).toBe('live');
  });
  it('respects the limit', () => {
    expect(parseYouTubeResults(ytPage(LOFI), 3).map((r) => r.videoId)).toEqual(['v1', 'v2', 'v3']);
  });
  it('returns nothing when the page has no data', () => {
    expect(parseYouTubeResults('<html>consent page</html>')).toEqual([]);
  });
});

describe('searchYouTube', () => {
  it('fetches the search page and parses it', async () => {
    let seen;
    const fetchImpl = async (url) => { seen = url; return new Response(ytPage(LOFI)); };
    const results = await searchYouTube('lofi hip hop', { fetchImpl });
    expect(seen).toBe(searchUrl('lofi hip hop'));
    expect(results[4].title).toBe('Chill Lofi Mix');
  });
  it('throws when no results can be read', async () => {
    await expect(searchYouTube('x', { fetchImpl: async () => new Response('<html></html>') })).rejects.toThrow(/results/);
  });
});

describe('apps', () => {
  it('parses Get-StartApps JSON (array or single object)', () => {
    expect(parseStartApps('[{"Name":"Calculator","AppID":"calc!App"}]')).toEqual([{ name: 'Calculator', appId: 'calc!App' }]);
    expect(parseStartApps('{"Name":"Spotify","AppID":"sp"}')).toEqual([{ name: 'Spotify', appId: 'sp' }]);
    expect(parseStartApps('')).toEqual([]);
  });
  it('ranks prefix matches above word and substring matches', () => {
    expect(matchApps(APPS, 'chrome').map((a) => a.name)).toEqual(['Google Chrome']);
    expect(matchApps(APPS, 'code').map((a) => a.name)).toEqual(['CodeBlocks', 'CodeBlocks (Launcher)', 'Visual Studio Code']);
  });
  it('resolves exact and unique names, otherwise returns candidates', () => {
    expect(resolveApp(APPS, 'calculator').app.appId).toBe('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App');
    expect(resolveApp(APPS, 'spotify').app.name).toBe('Spotify');
    expect(resolveApp(APPS, 'vs code')).toBeNull();
    expect(resolveApp(APPS, 'visual studio').app.name).toBe('Visual Studio Code');
    expect(resolveApp(APPS, 'code').candidates.map((a) => a.name)).toEqual(['CodeBlocks', 'CodeBlocks (Launcher)', 'Visual Studio Code']);
    expect(resolveApp(APPS, 'photoshop')).toBeNull();
  });
});

describe('laptop tools', () => {
  function setup({ fetchOk = true } = {}) {
    const opened = [];
    const launched = [];
    let fetches = 0;
    const tools = addLaptopTools(new ToolRegistry(), {
      openUrl: async (url) => { opened.push(url); },
      searchYouTube: async (query) => {
        fetches += 1;
        if (!fetchOk) throw new Error('blocked');
        return parseYouTubeResults(ytPage(LOFI.map(([id, title, ...rest]) => [id, `${title} (${query})`, ...rest])));
      },
      catalog: { all: async () => APPS },
      launchApp: async (appId) => { launched.push(appId); },
    });
    return { tools, opened, launched, fetches: () => fetches };
  }

  it('are all low risk, so they run without approval', () => {
    const { tools } = setup();
    for (const name of ['open_website', 'youtube_search', 'play_youtube', 'open_app']) expect(tools.get(name).tier).toBe('low');
  });

  it('open_website opens the normalised link', async () => {
    const { tools, opened } = setup();
    const out = await tools.get('open_website').run({ target: 'github.com' });
    expect(opened).toEqual(['https://github.com/']);
    expect(out.opened).toBe('https://github.com/');
  });

  it('youtube_search lists results and play_youtube picks a position from them without searching again', async () => {
    const { tools, opened, fetches } = setup();
    const list = await tools.get('youtube_search').run({ query: 'lofi' });
    expect(list.results[4]).toEqual({ position: 5, title: 'Chill Lofi Mix (lofi)', channel: 'Settle', length: '1:44:52' });
    const played = await tools.get('play_youtube').run({ position: 5 });
    expect(opened).toEqual([watchUrl('v5')]);
    expect(played.playing).toMatchObject({ position: 5, title: 'Chill Lofi Mix (lofi)' });
    expect(fetches()).toBe(1);
  });

  it('play_youtube with a query plays the top result by default', async () => {
    const { tools, opened } = setup();
    await tools.get('play_youtube').run({ query: 'lofi' });
    expect(opened).toEqual([watchUrl('v1')]);
  });

  it('play_youtube falls back to the search page when results cannot be read', async () => {
    const { tools, opened } = setup({ fetchOk: false });
    const out = await tools.get('play_youtube').run({ query: 'lofi', position: 2 });
    expect(opened).toEqual([searchUrl('lofi')]);
    expect(out.note).toMatch(/search page/);
  });

  it('play_youtube explains out-of-range positions and missing searches', async () => {
    const { tools } = setup();
    await expect(tools.get('play_youtube').run({ position: 2 })).rejects.toThrow(UserFacingError);
    await tools.get('youtube_search').run({ query: 'lofi' });
    await expect(tools.get('play_youtube').run({ position: 40 })).rejects.toThrow(/only 6/);
  });

  it('open_app launches a matched app, or returns candidates without launching', async () => {
    const { tools, launched } = setup();
    expect(await tools.get('open_app').run({ name: 'calculator' })).toMatchObject({ opened: 'Calculator' });
    expect(launched).toEqual(['Microsoft.WindowsCalculator_8wekyb3d8bbwe!App']);
    const out = await tools.get('open_app').run({ name: 'code' });
    expect(out.opened).toBeUndefined();
    expect(out.candidates).toEqual(['CodeBlocks', 'CodeBlocks (Launcher)', 'Visual Studio Code']);
    expect(launched).toHaveLength(1);
    await expect(tools.get('open_app').run({ name: 'photoshop' })).rejects.toThrow(/couldn't find/);
  });
});
