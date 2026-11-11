// context/location.ts

import type { LocationContext, UserMeta } from '../config/types.js';

export function getLocationContext(userMeta: UserMeta): LocationContext {
  const locationParts = userMeta.location.split(',').map(s => s.trim());
  const city = locationParts[0] || 'Unknown';
  const country = locationParts[locationParts.length - 1] || 'Unknown';

  return {
    city,
    country,
    timezone: userMeta.timezone,
    coordinates: userMeta.coordinates,
    isTravelling: false, // TODO: detect via user message or location update
  };
}
