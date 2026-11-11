// context/weather.ts

import type { WeatherContext } from '../config/types.js';
import type { Http } from '../voice/http.js';
import { asArray, asNumber, asObject, parseJson } from '../utils/json.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('weather');

let weatherCache: { data: WeatherContext; timestamp: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getWeatherContext(http: Http, lat: number, lng: number, locationName: string): Promise<WeatherContext | null> {
  if (weatherCache && Date.now() - weatherCache.timestamp < CACHE_TTL_MS) {
    return weatherCache.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&hourly=relative_humidity_2m`;
    const res = await http({ url, method: 'GET' });
    if (res.status >= 400) throw new Error(`open-meteo ${res.status}`);
    const body = asObject(parseJson(res.text));
    const current = asObject(body.current_weather);
    const humidity = asNumber(asArray(asObject(body.hourly).relative_humidity_2m)[new Date().getHours()]) ?? 0;
    const temp = asNumber(current.temperature);
    if (temp === undefined) throw new Error('open-meteo returned no temperature');

    const condition = mapWeatherCode(asNumber(current.weathercode) ?? -1);
    const isGoodForOutdoor = temp >= 15 && temp <= 35 && humidity < 85 && !condition.includes('rain');

    const summary = `${temp}C, ${condition}, ${humidity}% humidity${
      !isGoodForOutdoor ? ', indoor activity might be better' : ''
    }`;

    const data: WeatherContext = {
      location: locationName,
      temperature: temp,
      unit: 'C',
      condition,
      humidity,
      isGoodForOutdoor,
      summary,
    };

    weatherCache = { data, timestamp: Date.now() };
    return data;
  } catch (err) {
    logger.error('Weather fetch failed', err);
    return null;
  }
}

function mapWeatherCode(code: number): string {
  const codes: Record<number, string> = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
  };
  return codes[code] || 'Unknown';
}
