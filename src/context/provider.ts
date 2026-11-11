// context/provider.ts

import type { AgentConfig, ContextData } from '../config/types.js';
import type { Store } from '../store/store.js';
import type { Http } from '../voice/http.js';
import { getDateTimeContext } from './datetime.js';
import { getWeatherContext } from './weather.js';
import { getLocationContext } from './location.js';
import { getVaultState } from './vault-state.js';

export interface ContextOptions {
  /** Fetch weather from open-meteo (no key). Off when the user has no coordinates. */
  weather?: boolean;
  /** Obsidian's requestUrl. Without it there is no weather. */
  http?: Http;
}

export async function assembleContext(
  vaultPath: string,
  config: AgentConfig,
  store: Store,
  opts: ContextOptions = {},
): Promise<ContextData> {
  const datetime = getDateTimeContext(config.userMeta.timezone);
  const location = getLocationContext(config.userMeta);
  const { lat, lng } = config.userMeta.coordinates;
  const http = opts.http;
  const wantWeather = opts.weather !== false && (lat !== 0 || lng !== 0);

  const [weather, vault] = await Promise.all([
    wantWeather && http ? getWeatherContext(http, lat, lng, config.userMeta.location) : Promise.resolve(null),
    getVaultState(vaultPath, store, location),
  ]);

  // Calendar and health came from server integrations that are gone. The engine
  // can use its own calendar tools when asked.
  return { datetime, weather, calendar: null, health: null, location, vault };
}
