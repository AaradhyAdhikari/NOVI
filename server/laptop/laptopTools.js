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
  // The phone that asked (with Novi open), or null: { showVideo({ videoId, title }), showLink({ url, label }) }.
  askedFromPhone = () => null,
} = {}) {
  const ON = { type: 'string', enum: ['here', 'laptop'], description: '"laptop" only when the user says on the laptop; default "here" (the device they asked from)' };
  const phoneFor = (on) => (on === 'laptop' ? null : askedFromPhone());
  let last = null; // { query, results } from the latest YouTube search, for "play the 5th one"

  return registry
    .add({
      name: 'open_website',
      description: 'Open a website right away, on the device the user is using (the laptop, or a tap-to-open link on their phone). Pass a full https URL when you know the site (e.g. https://github.com, https://youtube.com), otherwise a search phrase (opens Google).',
      parameters: obj({ target: str('URL, domain, or search phrase'), on: ON }, ['target']),
      tier: 'low',
      describe: ({ target }) => `Open ${target}`,
      run: async ({ target, on }) => {
        const url = toUrl(target);
        const phone = phoneFor(on);
        if (phone) {
          phone.showLink({ url, label: new URL(url).hostname.replace(/^www\./, '') });
          return { opened: url, on: 'phone' };
        }
        await openUrl(url);
        return { opened: url, on: 'laptop' };
      },
    })
    .add({
      name: 'youtube_search',
      description: 'List YouTube results — ONLY when the user asks to see or choose from the options. To watch or play something ("show me valorant", "play X"), use play_youtube instead.',
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
      description: 'Play a YouTube video right away on the device the user is using ("play/show/watch X", "X lagao"). With a query, plays the top result (or `position`). Without a query, plays `position` from the most recent youtube_search. Then just say the title in a few words — never list results.',
      parameters: obj({ query: str('What to search for (omit to pick from the last search)'), position: { type: 'integer', description: '1-based position in the results, default 1' }, on: ON }),
      tier: 'low',
      describe: ({ query, position }) => `Play YouTube ${query || 'result'} #${position || 1}`,
      run: async ({ query, position = 1, on }) => {
        const phone = phoneFor(on);
        if (query) {
          try {
            last = { query, results: await searchYouTube(query) };
          } catch {
            if (phone) {
              phone.showLink({ url: searchUrl(query), label: `YouTube: ${query}` });
              return { opened: searchUrl(query), on: 'phone', note: "I couldn't read the results, so I sent you the YouTube search instead." };
            }
            await openUrl(searchUrl(query));
            return { opened: searchUrl(query), note: "I couldn't read the results, so I opened the YouTube search page instead." };
          }
        } else if (!last) {
          throw new UserFacingError('Tell me what to play, or search YouTube first.');
        }
        const pick = last.results[Number(position) - 1];
        if (!pick) throw new UserFacingError(`There are only ${last.results.length} results for "${last.query}".`);
        if (phone) {
          phone.showVideo({ videoId: pick.videoId, title: pick.title });
          return { playing: summary(pick), on: 'phone' };
        }
        await openUrl(watchUrl(pick.videoId));
        return { playing: summary(pick), on: 'laptop' };
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
