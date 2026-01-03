/**
 * Location detection utility for IVA backend
 * Detects multiple physical locations from crawled website content
 */

/**
 * Extract unique addresses from text using Czech address patterns
 */
function extractAddresses(text) {
  if (!text || typeof text !== 'string') return [];

  const addresses = new Set();

  // Czech address patterns:
  // - Street name + number + city: "Vinohradská 1193/85 Praha 2"
  // - Square/place + number + city: "Masarykovo náměstí 17, Kojetín"
  // - Street + number + postal code + city: "Národní 28, 110 00 Praha 1"
  
  // Pattern 1: Street name (with Czech chars) + number + optional city/postal
  const pattern1 = /([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)*\s+(?:náměstí|nám\.|ulice|ul\.|třída|tř\.)?)\s*([0-9]+(?:\/[0-9]+)?)(?:\s*,\s*)?(?:\s*([0-9]{3}\s*[0-9]{2})?\s*)?([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+(?:\s+[0-9]+)?)?/gi;
  
  // Pattern 2: Number + street + city (reversed order)
  const pattern2 = /([0-9]+(?:\/[0-9]+)?)\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)*)\s*,\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)/gi;

  // Pattern 3: City names followed by addresses
  const cityPattern = /(Praha|Brno|Ostrava|Plzeň|Liberec|Olomouc|České Budějovice|Hradec Králové|Ústí nad Labem|Pardubice|Zlín|Havířov|Kladno|Most|Opava|Frýdek-Místek|Jihlava|Karviná|Teplice|Děčín|Chomutov|Jablonec nad Nisou|Mladá Boleslav|Prostějov|Přerov|Česká Lípa|Třebíč|Třinec|Žďár nad Sázavou|Orlová|Nový Jičín|Kroměříž|Litvínov|Hodonín|Uherské Hradiště|Čáslav|Šumperk|Vsetín|Valašské Meziříčí|Litoměřice|Břeclav|Kopřivnice|Klatovy|Hranice|Jindřichův Hradec|Svitavy|Trutnov|Písek|Kutná Hora|Pelhřimov|Beroun|Dvůr Králové nad Labem|Český Krumlov|Mělník|Tábor|Příbram|Náchod|Rokycany|Jaroměř|Nymburk|Blansko|Kyjov|Vrchlabí|Boskovice|Žatec|Sokolov|Kraslice|Aš|Cheb|Mariánské Lázně|Karlovy Vary|Louny|Rakovník|Benešov|Kolín|Mladá Boleslav|Mělník|Neratovice|Brandýs nad Labem-Stará Boleslav|Říčany|Černošice|Roztoky|Kralupy nad Vltavou|Slaný|Kladno|Unhošť|Buštěhrad|Stochov|Nové Strašecí|Roudnice nad Labem|Litoměřice|Ústí nad Labem|Děčín|Varnsdorf|Rumburk|Šluknov|Česká Lípa|Nový Bor|Mimoň|Jablonec nad Nisou|Liberec|Frýdlant|Turnov|Semily|Jilemnice|Vrchlabí|Trutnov|Dvůr Králové nad Labem|Náchod|Nové Město nad Metují|Česká Skalice|Jaroměř|Hradec Králové|Pardubice|Chrudim|Vysoké Mýto|Ústí nad Orlicí|Lanškroun|Svitavy|Moravská Třebová|Litovel|Šumperk|Jeseník|Krnov|Bruntál|Opava|Hlučín|Kravaře|Bohumín|Orlová|Karviná|Havířov|Český Těšín|Frýdek-Místek|Frýdlant nad Ostravicí|Nový Jičín|Kopřivnice|Příbor|Fulnek|Bílovec|Odry|Studénka|Hranice|Lipník nad Bečvou|Přerov|Prostějov|Konice|Litovel|Uničov|Šternberk|Olomouc|Šumperk|Zábřeh|Mohelnice|Loštice|Litovel|Uničov|Šternberk|Olomouc|Šumperk|Zábřeh|Mohelnice|Loštice)/gi;

  // Try pattern 1
  let matches = text.matchAll(pattern1);
  for (const match of matches) {
    const fullMatch = match[0].trim();
    if (fullMatch.length > 10 && fullMatch.length < 200) {
      addresses.add(fullMatch);
    }
  }

  // Try pattern 2
  matches = text.matchAll(pattern2);
  for (const match of matches) {
    const fullMatch = match[0].trim();
    if (fullMatch.length > 10 && fullMatch.length < 200) {
      addresses.add(fullMatch);
    }
  }

  // Also look for city names as location indicators
  const cityMatches = text.matchAll(cityPattern);
  for (const match of cityMatches) {
    const city = match[1];
    // Look for address-like text near the city name
    const cityIndex = text.indexOf(match[0]);
    const context = text.slice(Math.max(0, cityIndex - 100), Math.min(text.length, cityIndex + 200));
    // Try to find a street + number pattern near the city
    const nearbyAddress = context.match(/([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+\s+[0-9]+(?:\/[0-9]+)?)/i);
    if (nearbyAddress) {
      addresses.add(`${nearbyAddress[1]}, ${city}`);
    }
  }

  return Array.from(addresses);
}

/**
 * Extract location names from URLs and text headings
 */
function extractLocationNames(chunks) {
  const locationNames = new Set();
  const cityPattern = /(praha|brno|ostrava|plzen|plzeň|liberec|olomouc)/gi;

  for (const chunk of chunks) {
    const url = chunk.kb_pages?.url || '';
    const text = chunk.text || '';
    const title = chunk.kb_pages?.title || '';

    // Extract from URL
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/praha')) locationNames.add('Praha');
    if (urlLower.includes('/brno')) locationNames.add('Brno');
    if (urlLower.includes('/ostrava')) locationNames.add('Ostrava');
    if (urlLower.includes('/plzen') || urlLower.includes('/plzeň')) locationNames.add('Plzeň');

    // Extract from text headings (h1, h2, h3 patterns or standalone city names)
    const combinedText = (title + '\n' + text).toLowerCase();
    const cityMatches = combinedText.matchAll(cityPattern);
    for (const match of cityMatches) {
      const city = match[1];
      // Capitalize first letter
      const capitalized = city.charAt(0).toUpperCase() + city.slice(1);
      locationNames.add(capitalized);
    }

    // Look for patterns like "Praha – Vinohrady" or "Brno – Za Divadlem"
    const locationPattern = /(Praha|Brno|Ostrava|Plzeň|Liberec|Olomouc)\s*[–-]\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+)*)/g;
    const locationMatches = (title + '\n' + text).matchAll(locationPattern);
    for (const match of locationMatches) {
      locationNames.add(match[0].trim());
    }
  }

  return Array.from(locationNames);
}

/**
 * Map booking providers to locations based on URL patterns
 */
function mapBookingProvidersToLocations(locations, chunks, detectedBookingProviders) {
  if (!detectedBookingProviders || detectedBookingProviders.length === 0 || locations.length === 0) {
    return locations;
  }

  // Track which URLs contain location-specific paths
  const urlLocationMap = new Map(); // url -> location name
  
  for (const chunk of chunks) {
    const url = (chunk.kb_pages?.url || '').toLowerCase();
    if (!url) continue;

    // Check for location-specific URL patterns
    if (url.includes('/praha') || url.includes('/praha-')) {
      urlLocationMap.set(url, 'praha');
    } else if (url.includes('/brno') || url.includes('/brno-')) {
      urlLocationMap.set(url, 'brno');
    } else if (url.includes('/ostrava') || url.includes('/ostrava-')) {
      urlLocationMap.set(url, 'ostrava');
    } else if (url.includes('/plzen') || url.includes('/plzeň') || url.includes('/plzen-')) {
      urlLocationMap.set(url, 'plzeň');
    }
  }

  // Assign providers to locations based on URL matching
  for (const location of locations) {
    if (!location.booking_providers) {
      location.booking_providers = [];
    }
    
    const locationName = (location.name || '').toLowerCase();
    const address = (location.address || '').toLowerCase();
    
    // Match providers if URL contains location name AND address contains location name
    for (const [url, urlLocation] of urlLocationMap.entries()) {
      if (locationName.includes(urlLocation) || address.includes(urlLocation)) {
        // Add all detected providers to this location
        for (const provider of detectedBookingProviders) {
          if (!location.booking_providers.includes(provider)) {
            location.booking_providers.push(provider);
          }
        }
        break; // Found a match, no need to check other URLs
      }
    }
  }

  return locations;
}

// Constants for location detection
const CITY_KEYWORDS = [
  'praha',
  'brno',
  'ostrava',
  'plzeň',
  'olomouc',
  'liberec',
  'hradec',
  'pardubice',
  'zlin',
  'ústí',
  'usti',
  'české budějovice',
  'ceske budejovice'
];

const JUNK_TOKENS = [
  'kč',
  'min',
  '%',
  'šampon',
  'masky',
  'používáme jen profesionální značky',
  'pouzivame jen profesionalni znacky'
];

/**
 * Check if a string contains a city keyword and return it
 */
function containsCityKeyword(str) {
  const lower = str.toLowerCase();
  for (const city of CITY_KEYWORDS) {
    if (lower.includes(city)) return city;
  }
  return null;
}

/**
 * Check if a string is probably a valid address
 */
function isProbablyAddress(str) {
  const lower = str.toLowerCase();
  if (!/\d/.test(str)) return false; // must have a digit
  if (!containsCityKeyword(str)) return false;
  for (const junk of JUNK_TOKENS) {
    if (lower.includes(junk)) return false;
  }
  // simple length constraint
  const trimmed = str.trim();
  if (trimmed.length < 8 || trimmed.length > 120) return false;
  return true;
}

/**
 * Normalize address string
 */
function normalizeAddress(str) {
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Infer location name from address
 */
function inferredLocationName(address) {
  const lower = address.toLowerCase();
  if (lower.includes('praha')) return 'Praha';
  if (lower.includes('brno')) return 'Brno';
  if (lower.includes('ostrava')) return 'Ostrava';
  if (lower.includes('plzeň') || lower.includes('plzen')) return 'Plzeň';
  if (lower.includes('olomouc')) return 'Olomouc';
  if (lower.includes('liberec')) return 'Liberec';
  if (lower.includes('hradec')) return 'Hradec Králové';
  if (lower.includes('pardubice')) return 'Pardubice';
  if (lower.includes('zlin')) return 'Zlín';
  if (lower.includes('usti') || lower.includes('ústí')) return 'Ústí nad Labem';
  if (lower.includes('ceske budejovice') || lower.includes('české budějovice')) return 'České Budějovice';
  return 'Lokace';
}

/**
 * Normalize and filter locations to keep only real branch addresses
 */
function normalizeAndFilterLocations(rawLocations) {
  const seen = new Set();
  const result = [];

  for (const loc of rawLocations) {
    if (!loc.address) continue;

    const addrNorm = normalizeAddress(loc.address);
    if (!isProbablyAddress(addrNorm)) continue;

    const key = addrNorm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let name = loc.name;
    if (!name || /^lokace/i.test(name)) {
      name = inferredLocationName(addrNorm);
    }

    result.push({
      ...loc,
      name,
      address: addrNorm,
      booking_providers: loc.booking_providers || []
    });
  }

  return result;
}

/**
 * Seed base location from extracted profile address
 */
function seedBaseLocationFromProfile(extractedProfile, detectedBookingProviders) {
  const addr = extractedProfile?.address;
  if (!addr || typeof addr !== 'string') return null;

  const addrNorm = normalizeAddress(addr);
  if (!isProbablyAddress(addrNorm)) {
    // even if not passing strict isProbablyAddress, we still might want it
    // but for now, require city + digit
    if (!containsCityKeyword(addrNorm) || !/\d/.test(addrNorm)) {
      return null;
    }
  }

  return {
    name: inferredLocationName(addrNorm),
    address: addrNorm,
    booking_providers: detectedBookingProviders ?? []
  };
}

/**
 * Select canonical location per city, preferring base location
 */
function selectCanonicalPerCity(baseLocation, candidates) {
  // Group candidates by city keyword
  const byCity = new Map();

  for (const loc of candidates) {
    const city = containsCityKeyword(loc.address) || 'unknown';
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(loc);
  }

  const results = [];

  // If we have a baseLocation from extractedProfile, prefer it for its city.
  if (baseLocation) {
    const city = containsCityKeyword(baseLocation.address) || 'unknown';
    results.push(baseLocation);
    byCity.delete(city); // other candidates from same city will be ignored for now
  }

  // For remaining cities, pick the "best" candidate per city:
  for (const [city, locs] of byCity.entries()) {
    if (city === 'unknown') continue;

    const sorted = [...locs].sort((a, b) => {
      const aAddr = a.address;
      const bAddr = b.address;
      // Prefer addresses with "/" in number (more precise)
      const aHasSlash = aAddr.includes('/');
      const bHasSlash = bAddr.includes('/');
      if (aHasSlash !== bHasSlash) return aHasSlash ? -1 : 1;

      // Then prefer shorter strings (less garbage)
      if (aAddr.length !== bAddr.length) return aAddr.length - bAddr.length;

      // fallback alphabetical
      return aAddr.localeCompare(bAddr);
    });

    const best = sorted[0];
    results.push(best);
  }

  // Hard cap: at most 5 locations overall
  return results.slice(0, 5);
}

/**
 * Main function: Detect locations from chunks
 */
export function detectLocationsFromChunks({ chunks, extractedProfile, detectedBookingProviders }) {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  // Step 1: Extract unique addresses from all chunks
  const allText = chunks.map(c => c.text || '').join('\n\n');
  const addresses = extractAddresses(allText);

  // Step 2: Extract location names from URLs and headings
  const locationNames = extractLocationNames(chunks);

  // Step 3: Build location objects
  const rawLocations = [];

  // If we have multiple addresses, create one location per address
  if (addresses.length > 1) {
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      // Try to match with a location name
      let name = null;
      for (const locName of locationNames) {
        const locNameLower = locName.toLowerCase();
        if (address.toLowerCase().includes(locNameLower)) {
          name = locName;
          break;
        }
      }
      // If no match, use city from address or generic name
      if (!name) {
        const cityMatch = address.match(/(Praha|Brno|Ostrava|Plzeň|Liberec|Olomouc)/i);
        name = cityMatch ? cityMatch[1] : `Lokace ${i + 1}`;
      }

      rawLocations.push({
        name: name,
        address: address,
        booking_providers: []
      });
    }
  } else if (addresses.length === 1) {
    // Single address - check if we have multiple location names
    const address = addresses[0];
    if (locationNames.length > 1) {
      // Multiple location names but one address - create entries for each name
      for (const locName of locationNames) {
        rawLocations.push({
          name: locName,
          address: address, // Same address for all
          booking_providers: []
        });
      }
    } else {
      // Single address, single or no location name
      const name = locationNames.length > 0 ? locationNames[0] : null;
      rawLocations.push({
        name: name,
        address: address,
        booking_providers: []
      });
    }
  } else if (locationNames.length > 0) {
    // No addresses found, but we have location names
    for (const locName of locationNames) {
      rawLocations.push({
        name: locName,
        address: extractedProfile?.address || null, // Fallback to extracted profile address
        booking_providers: []
      });
    }
  } else if (extractedProfile?.address) {
    // No addresses or location names, but we have an address from profile
    rawLocations.push({
      name: null,
      address: extractedProfile.address,
      booking_providers: []
    });
  }

  // Step 4: Normalize and filter locations (strong filter layer)
  const cleaned = normalizeAndFilterLocations(rawLocations);

  // Step 5: Seed base location from extracted profile address
  const baseLocation = seedBaseLocationFromProfile(extractedProfile, detectedBookingProviders || []);

  // Step 6: Select canonical location per city (preferring base location)
  const finalLocations = selectCanonicalPerCity(baseLocation, cleaned);

  // Step 7: Map booking providers to locations (improved URL-based matching)
  const locationsWithProviders = mapBookingProvidersToLocations(
    finalLocations,
    chunks,
    detectedBookingProviders || []
  );

  // Step 8: If no locations found but we have an address in profile, return it
  if (locationsWithProviders.length === 0 && extractedProfile?.address) {
    return [{
      name: null,
      address: extractedProfile.address,
      booking_providers: detectedBookingProviders || []
    }];
  }

  // Debug logging
  console.log(`[LOCATIONS] Raw: ${rawLocations.length}, Cleaned: ${cleaned.length}, Final: ${locationsWithProviders.length}`);

  return locationsWithProviders;
}

