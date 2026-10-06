/** Separators users type between cities: 、，, / ; and whitespace. */
const CITY_SEPARATORS = /[、,，/／;；|\s]+/u;

/** Splits the stored city text into single-city tags, keeping the first spelling of each. */
export function splitCities(value: string): string[] {
  const seen = new Set<string>();
  const cities: string[] = [];
  for (const part of value.split(CITY_SEPARATORS)) {
    const city = part.trim();
    if (!city || seen.has(city.toLocaleLowerCase())) continue;
    seen.add(city.toLocaleLowerCase());
    cities.push(city);
  }
  return cities;
}

/** The stored form of a city tag list. */
export function joinCities(cities: readonly string[]): string {
  return splitCities(cities.join('、')).join('、');
}
