import * as cheerio from 'cheerio';

/**
 * @typedef {Object} ExtractedService
 * @property {string} name
 * @property {string|null} description
 * @property {number|null} durationMinutes
 * @property {number|null} priceFrom
 * @property {number|null} priceTo
 * @property {boolean} isCore
 */

/**
 * Parses duration text like "(Délka: 30 min)" or "(Délka: 1 hod)" into minutes
 * @param {string} text - Duration text
 * @returns {number|null} Duration in minutes
 */
function parseDurationMinutes(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // e.g. "(Délka: 30 min)"
  const minMatch = t.match(/(\d+)\s*min/);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  // e.g. "(Délka: 1 hod)", "(Délka: 2 hod)", "(Délka: 1,5 hod)"
  const hodMatch = t.match(/(\d+(?:[.,]\d+)?)\s*hod/);
  if (hodMatch) {
    const hours = parseFloat(hodMatch[1].replace(',', '.'));
    return Math.round(hours * 60);
  }

  return null;
}

/**
 * Parses price text like "990 Kč" or "500 - 800 Kč" into priceFrom and priceTo
 * @param {string} text - Price text
 * @returns {{priceFrom: number|null, priceTo: number|null}} Price range
 */
function parsePriceRange(text) {
  if (!text) return { priceFrom: null, priceTo: null };
  const cleaned = text
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, '')
    .trim();

  const parseCzNumber = (s) => {
    if (!s) return null;
    // supports "1 999", "1.999", "1,999"
    const digits = s.replace(/[^\d]/g, '');
    if (!digits) return null;
    const val = parseInt(digits, 10);
    return Number.isFinite(val) ? val : null;
  };

  // "500 - 800 Kč" or "500–800 Kč"
  let m = cleaned.match(/(\d[\d., ]*)[–-](\d[\d., ]*)kč?/i);
  if (m) {
    const from = parseCzNumber(m[1]);
    const to = parseCzNumber(m[2]);
    return { priceFrom: from, priceTo: to };
  }

  // "990 Kč" or "od990Kč"
  m = cleaned.match(/(\d[\d., ]*)kč?/i);
  if (m) {
    const value = parseCzNumber(m[1]);
    return { priceFrom: value, priceTo: value };
  }

  return { priceFrom: null, priceTo: null };
}

/**
 * Optional normalization: keeps behaviour generic but removes some prefixes.
 * Do NOT hardcode salon-specific names; just generic transformations.
 * @param {string} raw - Raw service name
 * @returns {string} Normalized service name
 */
function normalizeServiceName(raw) {
  if (!raw) return '';

  let name = raw.replace(/\s+/g, ' ').trim();

  // drop "Klasický " at the beginning (so "Klasický pánský střih" → "Pánský střih")
  name = name.replace(/^Klasick[ýá]\s+/i, '');

  // Remove trailing footnote markers like "*" / "**"
  name = name.replace(/\s*[*†‡]+$/g, '').trim();

  return name;
}

/**
 * Checks if a URL looks like a price list page
 * @param {string} url - Page URL
 * @returns {boolean} True if URL looks like a price list
 */
function isPriceListUrl(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  
  // Check for common price list URL patterns
  return (
    lowerUrl.includes('cenik-kadernictvi') ||
    lowerUrl.includes('cenik') ||
    lowerUrl.includes('cennik') ||
    lowerUrl.includes('ceny') ||
    lowerUrl.includes('price') ||
    lowerUrl.includes('pricelist')
  );
}

/**
 * Extracts services from a price list DOM where each row is in `.block-listitem .listitem`.
 * This is tuned for structures like Cutegory's `/cenik-kadernictvi-praha`.
 *
 * @param {string} html - HTML content of the page
 * @param {string} url - Page URL (for logging)
 * @returns {ExtractedService[]} Array of extracted services
 */
export function extractServicesFromPriceList(html, url = '') {
  if (!html) return [];

  const $ = cheerio.load(html);
  const services = [];

  // Try multiple selectors to be more flexible
  const selectors = [
    '.block-listitem .listitem',
    '.listitem',
    '.price-list .item',
    '.service-item',
    '[class*="price"] [class*="item"]'
  ];

  let foundItems = false;
  for (const selector of selectors) {
    const items = $(selector);
    if (items.length > 0) {
      foundItems = true;
      
      items.each((_, el) => {
        const $el = $(el);

        // Try to find service name in h4, h3, or strong tags
        const rawName = $el.find('h4').first().text() ||
                        $el.find('h3').first().text() ||
                        $el.find('strong').first().text() ||
                        $el.find('[class*="name"]').first().text();
        
        const name = normalizeServiceName(rawName);
        if (!name) return;

        // Find duration text - look for "Délka" or "délka" in paragraph text
        const durationText = $el
          .find('p')
          .filter((_, p) => {
            const text = $(p).text().toLowerCase();
            return text.includes('délka') || text.includes('doba') || text.includes('min') || text.includes('hod');
          })
          .first()
          .text();

        // Find price text - prioritize p.right strong (Cutegory structure), then other patterns
        const priceText = $el.find('p.right strong').first().text() ||
                         $el.find('p.right').first().text() ||
                         $el.find('strong').first().text() ||
                         $el.find('[class*="price"]').first().text() ||
                         $el.text().match(/\d+\s*[–-]?\s*\d*\s*kč/i)?.[0] || '';

        const durationMinutes = parseDurationMinutes(durationText);
        const { priceFrom, priceTo } = parsePriceRange(priceText);

        // Only keep a service if at least name and *some* price or duration was found
        if (!durationMinutes && priceFrom == null && priceTo == null) {
          // If we got just a name with no numeric info, better to skip than create junk
          return;
        }

        services.push({
          name,
          description: null,
          durationMinutes,
          priceFrom,
          priceTo,
          // Core only when it has real numeric info
          isCore: Boolean(durationMinutes || priceFrom != null || priceTo != null),
        });
      });

      // If we found items with this selector, break (don't try other selectors)
      if (services.length > 0) {
        break;
      }
    }
  }

  if (services.length > 0) {
    console.log(`[ONBOARDING] Extracted ${services.length} services from price list DOM (${url})`);
  }

  return services;
}

/**
 * Checks if a URL looks like a price list and extracts services from its HTML
 * @param {string} url - Page URL
 * @param {string} html - Page HTML
 * @returns {ExtractedService[]} Extracted services or empty array
 */
export function extractServicesIfPriceList(url, html) {
  if (!isPriceListUrl(url)) {
    return [];
  }

  return extractServicesFromPriceList(html, url);
}

