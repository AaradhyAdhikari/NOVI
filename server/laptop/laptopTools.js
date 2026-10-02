import { UserFacingError } from '../errors.js';
import { toUrl, openUrl as defaultOpenUrl } from './opener.js';
import { searchYouTube as defaultSearchYouTube, searchUrl, watchUrl } from './youtube.js';
import { AppCatalog, resolveApp, launchApp as defaultLaunchApp } from './apps.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const summary = ({ position, title, channel, length }) => ({ position, title, channel, length });

// Low-risk laptop actions: they open things on the laptop, never change or delete anything.
export function addLaptopTools(registry, {
  openUrl = defaultOpenUrl,
  searchYouTube = defaultSearchYouTube,
  catalog = new AppCatalog(),
  launchApp = defaultLaunchApp,
} = {}) {
  let last = null; // { query, results } from the latest YouTube search, for "play the 5th one"

  return registry
    .add({
      name: 'open_website',
      description: 'Open a website in the laptop\'s browser. Pass a full https URL when you know the site (e.g. https://github.com), otherwise a search phrase (opens Google).',
      parameters: obj({ target: str('URL, domain, or search phrase') }, ['target']),
      tier: 'low',
      describe: ({ target }) => `Open ${target}`,
      run: async ({ target }) => {
        const url = toUrl(target);
        await openUrl(url);
        return { opened: url };
      },
    })
    .add({
      name: 'youtube_search',
      description: 'Search YouTube and list the top results with their positions, so the user can pick one (e.g. "play the 5th one").',
      parameters: obj({ query: str('What to search for') }, ['query']),
      tier: 'low',
      describe: ({ query }) => `Search YouTube for ${query}`,
      run: async ({ query }) => {
        let results;
        try {
          results = await searchYouTube(query);
        } catch {
          throw new UserFacingError("I couldn't read YouTube's results right now.");
        }
        last = { query, results };
        return { query, results: results.map(summary) };
      },
    })
    .add({
      name: 'play_youtube',
      description: 'Play a YouTube video on the laptop. With a query, searches and plays the result at `position` (default 1, the top result). Without a query, plays `position` from the most recent youtube_search.',
      parameters: obj({ query: str('What to search for (omit to pick from the last search)'), position: { type: 'integer', description: '1-based position in the results, default 1' } }),
      tier: 'low',
      describe: ({ query, position }) => `Play YouTube ${query || 'result'} #${position || 1}`,
      run: async ({ query, position = 1 }) => {
        if (query) {
          try {
            last = { query, results: await searchYouTube(query) };
          } catch {
            await openUrl(searchUrl(query));
            return { opened: searchUrl(query), note: "I couldn't read the results, so I opened the YouTube search page instead." };
          }
        } else if (!last) {
          throw new UserFacingError('Tell me what to play, or search YouTube first.');
        }
        const pick = last.results[Number(position) - 1];
        if (!pick) throw new UserFacingError(`There are only ${last.results.length} results for "${last.query}".`);
        await openUrl(watchUrl(pick.videoId));
        return { playing: summary(pick) };
      },
    })
    .add({
      name: 'open_app',
      description: 'Open an installed app on the laptop by name (e.g. "Spotify", "Calculator", "Visual Studio Code"). If the name is ambiguous, the result lists candidates to ask the user about.',
      parameters: obj({ name: str('App name') }, ['name']),
      tier: 'low',
      describe: ({ name }) => `Open ${name}`,
      run: async ({ name }) => {
        const match = resolveApp(await catalog.all(), name);
        if (!match) throw new UserFacingError(`I couldn't find an app called "${name}" on this laptop.`);
        if (match.candidates) return { candidates: match.candidates.map((a) => a.name), note: `Which one did you mean: ${match.candidates.map((a) => a.name).join(', ')}?` };
        await launchApp(match.app.appId);
        return { opened: match.app.name };
      },
    });
}
