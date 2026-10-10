import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createWeatherPlugin } from '../../plugins/weather/index.js';

const PUNE = { name: 'Pune', latitude: 18.52, longitude: 73.86, country: 'India', admin1: 'Maharashtra', timezone: 'Asia/Kolkata' };
const FORECAST = {
  current: { time: '2026-10-07T09:00', temperature_2m: 27.4, apparent_temperature: 29.1, relative_humidity_2m: 70, precipitation: 0, weather_code: 2, wind_speed_10m: 8.3 },
  daily: {
    time: ['2026-10-07', '2026-10-08', '2026-10-09'],
    weather_code: [61, 3, 0],
    temperature_2m_max: [30.2, 29.0, 31.4],
    temperature_2m_min: [21.1, 20.4, 22.0],
    precipitation_probability_max: [80, 20, 0],
  },
};

function setup({ env = {}, geocode = { results: [PUNE] }, forecast = FORECAST } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://geocoding-api.open-meteo.com/v1/search')) return new Response(JSON.stringify(geocode));
    if (String(url).startsWith('https://api.open-meteo.com/v1/forecast')) return new Response(JSON.stringify(forecast));
    throw new Error(`unexpected ${url}`);
  };
  const host = new PluginHost({ runtime: {}, env, logger: { warn() {} } });
  expect(host.register(createWeatherPlugin({ fetchImpl }))).toBe(true);
  return { host, calls };
}

describe('weather plugin (Open-Meteo, no key)', () => {
  it('looks up the place, then reports current weather and today', async () => {
    const { host, calls } = setup();
    const out = await host.get('weather_get').run({ place: 'Pune' });
    expect(calls[0]).toContain('name=Pune');
    const forecastUrl = new URL(calls[1]);
    expect(forecastUrl.searchParams.get('latitude')).toBe('18.52');
    expect(forecastUrl.searchParams.get('longitude')).toBe('73.86');
    expect(forecastUrl.searchParams.get('forecast_days')).toBe('1');
    expect(out.text).toMatch(/Pune, Maharashtra/);
    expect(out.text).toMatch(/27°C/);
    expect(out.text).toMatch(/partly cloudy/i);
    expect(out.text).toMatch(/feels like 29°C/);
    expect(out.text).toMatch(/slight rain/i);
    expect(out.text).toMatch(/80% chance of rain/);
    expect(out.place).toBe('Pune, Maharashtra, India');
  });

  it('gives a multi-day forecast when asked', async () => {
    const { host, calls } = setup();
    const out = await host.get('weather_get').run({ place: 'Pune', days: 3 });
    expect(new URL(calls[1]).searchParams.get('forecast_days')).toBe('3');
    expect(out.days).toHaveLength(3);
    expect(out.text).toMatch(/clear sky/i);
    expect(out.text).toMatch(/31°C/);
  });

  it('clamps days to 1..7', async () => {
    const { host, calls } = setup();
    await host.get('weather_get').run({ place: 'Pune', days: 30 });
    expect(new URL(calls[1]).searchParams.get('forecast_days')).toBe('7');
  });

  it('uses the home place from NOVI_PLUGIN_WEATHER_PLACE when none is given', async () => {
    const { host, calls } = setup({ env: { NOVI_PLUGIN_WEATHER_PLACE: 'Pune' } });
    await host.get('weather_get').run({});
    expect(calls[0]).toContain('name=Pune');
  });

  it('asks for a place when none is given and no home place is set', async () => {
    const { host, calls } = setup();
    const out = await host.get('weather_get').run({});
    expect(out.text).toMatch(/which (city|place)/i);
    expect(calls).toEqual([]);
  });

  it('says so when the place is not found', async () => {
    const { host } = setup({ geocode: {} });
    const out = await host.get('weather_get').run({ place: 'Nowhereville' });
    expect(out.text).toMatch(/couldn't find.*Nowhereville/i);
  });

  it('needs no approval (read-only)', async () => {
    const { host } = setup();
    expect(await host.get('weather_get').gate({ place: 'Pune' })).toEqual({});
  });
});

describe('weather: never made up', () => {
  it('tells the brain to always fetch the weather instead of answering from memory', () => {
    const { host } = setup();
    const d = host.schemas().find((s) => s.function.name === 'weather_get').function.description;
    expect(d).toMatch(/never .*(guess|memory|make)/i);
  });
});
