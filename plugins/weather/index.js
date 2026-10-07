import { definePluginEntry } from '#plugin-sdk';

// Weather from Open-Meteo: free, no API key. Home city comes from NOVI_PLUGIN_WEATHER_PLACE.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather codes used by Open-Meteo.
const CODES = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'slight rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
const describe = (code) => CODES[code] || 'unknown conditions';
const deg = (n) => `${Math.round(n)}°C`;
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
  return res.json();
}

export function createWeatherPlugin({ fetchImpl = fetch } = {}) {
  return definePluginEntry({
    id: 'weather',
    name: 'Weather',
    description: 'Current weather and forecasts from Open-Meteo (free, no key).',
    register(api) {
      api.registerTool({
        name: 'weather_get',
        description: 'Get the current weather and the forecast for a city. Omit place to use the home city. days = how many days of forecast (1 = today only, max 7).',
        parameters: {
          type: 'object',
          properties: {
            place: { type: 'string', description: 'City or town, e.g. "Pune" or "Mumbai"; omit for the home city' },
            days: { type: 'number', description: 'Days of forecast, 1-7 (default 1)' },
          },
        },
        async execute(_toolCallId, { place, days } = {}) {
          const name = String(place || api.pluginConfig.place || '').trim();
          if (!name) return reply('Which city should I check the weather for? (Set NOVI_PLUGIN_WEATHER_PLACE in .env for a default.)');
          const n = Math.min(7, Math.max(1, Math.round(Number(days) || 1)));

          const geo = await getJson(fetchImpl, `${GEOCODE_URL}?${new URLSearchParams({ name, count: '1', language: 'en', format: 'json' })}`);
          const hit = geo.results?.[0];
          if (!hit) return reply(`I couldn't find a place called "${name}".`);
          const label = [hit.name, hit.admin1].filter(Boolean).join(', ');

          const f = await getJson(fetchImpl, `${FORECAST_URL}?${new URLSearchParams({
            latitude: String(hit.latitude),
            longitude: String(hit.longitude),
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
            timezone: 'auto',
            forecast_days: String(n),
          })}`);

          const c = f.current;
          const d = f.daily;
          const dayList = d.time.map((date, i) => ({
            date,
            summary: describe(d.weather_code[i]),
            min: d.temperature_2m_min[i],
            max: d.temperature_2m_max[i],
            rainChance: d.precipitation_probability_max?.[i] ?? null,
          }));
          const dayText = (x) => `${x.summary}, ${deg(x.min)} to ${deg(x.max)}${x.rainChance != null ? `, ${x.rainChance}% chance of rain` : ''}`;
          const lines = [
            `${label}: now ${deg(c.temperature_2m)} (feels like ${deg(c.apparent_temperature)}), ${describe(c.weather_code)}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.`,
            n === 1 ? `Today: ${dayText(dayList[0])}.` : dayList.map((x) => `${dayName(x.date)}: ${dayText(x)}.`).join('\n'),
          ];
          return reply(lines.join('\n'), {
            place: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
            current: { temperature: c.temperature_2m, feelsLike: c.apparent_temperature, summary: describe(c.weather_code), humidity: c.relative_humidity_2m, wind: c.wind_speed_10m },
            days: dayList,
          });
        },
      });
    },
  });
}

export default createWeatherPlugin();
