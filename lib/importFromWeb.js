/**
 * @typedef {Object} ImportedProfile
 * @property {string} name
 * @property {string|null} address
 * @property {string|null} phone
 * @property {string|null} email
 * @property {string|null} website
 */

/**
 * @typedef {Object} ImportedService
 * @property {string} name
 * @property {string|null} description
 * @property {number|null} durationMinutes
 * @property {number|null} priceFrom
 * @property {number|null} priceTo
 * @property {boolean} isCore
 */

/**
 * @typedef {Object} ImportedOpeningHour
 * @property {string} weekday - 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
 * @property {string|null} opensAt - Time in HH:MM format
 * @property {string|null} closesAt - Time in HH:MM format
 * @property {boolean} closed
 */

/**
 * @typedef {Object} ImportedBusinessData
 * @property {ImportedProfile} profile
 * @property {ImportedService[]} services
 * @property {ImportedOpeningHour[]} openingHours
 */

import { crawlWebsiteWithPlaywright } from '../crawlers/playwrightCrawler.js';
import { extractServicesIfPriceList } from './extractServicesFromPriceList.js';
import { extractContactFromPages, mergeContactData } from './extractContact.js';
import { pickBusinessName, scoreBusinessName, isGenericBusinessName } from './pickBusinessName.js';
import { chromium } from 'playwright';

/**
 * Crawls a business website and extracts structured business data.
 * 
 * @param {string} url - Website URL to crawl
 * @param {Object} options - Options object
 * @param {string} options.businessId - Business UUID
 * @param {any} options.supabase - Supabase client instance
 * @param {any} options.openai - OpenAI client instance
 * @param {Function} options.chunkText - Text chunking function
 * @param {Function} options.cleanText - Text cleaning function
 * @returns {Promise<ImportedBusinessData>} Extracted business data
 */
async function crawlBusinessWebsite(url, options) {
  const { businessId, supabase, openai, chunkText, cleanText } = options;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    throw new Error('INVALID_URL: URL must be a valid HTTP/HTTPS URL');
  }

  if (!businessId) {
    throw new Error('businessId is required');
  }

  if (!supabase) {
    throw new Error('supabase client is required');
  }

  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }

  console.log(`[ONBOARDING] Starting crawl for business ${businessId}, URL: ${url}`);

  // Step 1: Create/upsert kb_source
  const sourceData = {
    business_id: businessId,
    type: 'web',
    source_url: url,
    status: 'indexing',
    created_at: new Date().toISOString()
  };

  const { data: existingSources } = await supabase
    .from('kb_sources')
    .select('id')
    .eq('business_id', businessId)
    .eq('type', 'web')
    .eq('source_url', url)
    .limit(1);

  const existingSource = existingSources && existingSources.length > 0 ? existingSources[0] : null;
  let sourceRow;

  if (existingSource) {
    const { data, error: updateErr } = await supabase
      .from('kb_sources')
      .update(sourceData)
      .eq('id', existingSource.id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    sourceRow = data;
  } else {
    const { data, error: insertErr } = await supabase
      .from('kb_sources')
      .insert(sourceData)
      .select()
      .single();
    if (insertErr) throw insertErr;
    sourceRow = data;
  }

  const sourceId = sourceRow.id;
  console.log(`[ONBOARDING] Created/updated kb_source ${sourceId}`);

  // Step 2: Delete old chunks and pages for reindex
  await supabase.from('kb_chunks').delete().eq('source_id', sourceId);
  await supabase.from('kb_pages').delete().eq('source_id', sourceId);

  // Step 3: Crawl website
  let crawlResult;
  try {
    crawlResult = await crawlWebsiteWithPlaywright({
      baseUrl: url,
      maxDepth: 2,
      maxPages: 20,
      excludePaths: [],
      businessId: businessId,
      sourceId: sourceId,
      forcedUrls: [],
      chunkText,
      cleanText,
      supabase
    });
  } catch (crawlError) {
    console.error(`[ONBOARDING] Crawl failed for ${url}:`, crawlError);
    await supabase
      .from('kb_sources')
      .update({
        status: 'failed',
        last_indexed_at: new Date().toISOString()
      })
      .eq('id', sourceId);
    
    const errorMsg = crawlError?.message || String(crawlError) || 'Unknown crawl error';
    if (errorMsg.includes('timeout') || errorMsg.includes('network') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ETIMEDOUT')) {
      throw new Error('FETCH_FAILED: Failed to load website');
    }
    throw new Error(`FETCH_FAILED: ${errorMsg}`);
  }

  console.log(`[ONBOARDING] Crawled ${crawlResult.pagesIndexed} pages, created ${crawlResult.chunksCreated} chunks`);

  // Extract contact info (phone/email/address) from crawled pages BEFORE LLM extraction
  // This is deterministic and uses tel:/mailto: links, JSON-LD, and regex
  let deterministicContact = { phone: null, email: null, address: null, sources: {} };
  if (crawlResult.pages && Array.isArray(crawlResult.pages)) {
    // Debug: log pages being passed to extraction
    console.log(`[ONBOARDING] Pages available for contact extraction: ${crawlResult.pages.length}`);
    for (const page of crawlResult.pages) {
      const hasHtml = !!page.html;
      const htmlLen = page.html?.length || 0;
      const hasMailto = page.html?.includes('mailto:') || false;
      const hasTel = page.html?.includes('tel:') || false;
      console.log(`[ONBOARDING]   - ${page.url}: html=${hasHtml} (${htmlLen} chars), mailto=${hasMailto}, tel=${hasTel}`);
    }
    
    deterministicContact = extractContactFromPages(crawlResult.pages);
    console.log(`[ONBOARDING] Deterministic contact extraction:`, {
      phone: deterministicContact.phone || '(not found)',
      email: deterministicContact.email || '(not found)',
      address: deterministicContact.address || '(not found)',
      sources: deterministicContact.sources,
    });
  }

  // Extract services from price list pages using DOM-based extraction
  let domExtractedServices = [];
  if (crawlResult.pages && Array.isArray(crawlResult.pages)) {
    for (const page of crawlResult.pages) {
      if (page.html && page.url) {
        const pageServices = extractServicesIfPriceList(page.url, page.html);
        domExtractedServices.push(...pageServices);
      }
    }
    if (domExtractedServices.length > 0) {
      console.log(`[ONBOARDING] Extracted ${domExtractedServices.length} services from price list pages via DOM`);
    }
  }

  // Update source status
  await supabase
    .from('kb_sources')
    .update({
      status: 'success',
      chunks_count: crawlResult.chunksCreated,
      last_indexed_at: new Date().toISOString()
    })
    .eq('id', sourceId);

  // Step 5: Extract profile from chunks
  const { data: chunks, error: chunksError } = await supabase
    .from('kb_chunks')
    .select(`
      text,
      chunk_index,
      kb_pages (
        url,
        title
      )
    `)
    .eq('source_id', sourceId);

  if (chunksError) {
    throw new Error(`Failed to load KB chunks: ${chunksError.message || 'Unknown error'}`);
  }

  if (!chunks || chunks.length === 0) {
    throw new Error('PARSE_FAILED: No content extracted from website');
  }

  // Build website text from chunks
  let websiteText = chunks
    .map(chunk => `[${chunk.kb_pages?.title || chunk.kb_pages?.url || 'Page'}]\n${chunk.text}`)
    .join('\n\n');

  if (websiteText.length > 40000) {
    websiteText = websiteText.substring(0, 40000);
  }

  // Extract phone number using regex (runs before OpenAI extraction as fallback/improvement)
  function extractCzechPhone(text) {
    if (!text) return null;
    
    // Czech phone formats: +420 608 744 774, +420608744774, 608 744 774, 608744774, etc.
    // Pattern matches: +420 (optional) followed by 9 digits (may have spaces/dashes)
    const phoneRegex = /(\+?\s?420[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}|[0-9]{3}\s?[0-9]{3}\s?[0-9]{3,})/;
    const match = text.match(phoneRegex);
    if (match) {
      // Normalize: remove spaces, ensure +420 prefix
      let phone = match[0].replace(/\s+/g, '').replace(/-/g, '');
      if (!phone.startsWith('+420') && phone.length === 9) {
        phone = '+420' + phone;
      } else if (!phone.startsWith('+') && phone.startsWith('420')) {
        phone = '+' + phone;
      }
      return phone;
    }
    return null;
  }

  // Extract opening hours from Czech text using heuristics
  function extractCzechOpeningHours(text) {
    if (!text) return null;
    
    // Map normalized (unaccented) Czech weekday names to English keys
    const normalizedWeekdayMap = {
      'pondeli': 'mon',
      'utery': 'tue',
      'streda': 'wed',
      'ctvrtek': 'thu',
      'patek': 'fri',
      'sobota': 'sat',
      'nedele': 'sun'
    };
    
    const normalizedWeekdayOrder = ['pondeli', 'utery', 'streda', 'ctvrtek', 'patek', 'sobota', 'nedele'];
    
    // Normalize text: lowercase, remove accents for matching
    const normalized = text.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    
    // Pattern 1: Range like "Pondělí - Neděle 8:00 - 20:00" or "Pondělí–Neděle 8:00–20:00"
    // Match normalized weekday names
    const rangePattern = /(pondeli|utery|streda|ctvrtek|patek|sobota|nedele)\s*[-–]\s*(pondeli|utery|streda|ctvrtek|patek|sobota|nedele)\s+(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/i;
    const rangeMatch = normalized.match(rangePattern);
    
    if (rangeMatch) {
      const startDay = rangeMatch[1].toLowerCase();
      const endDay = rangeMatch[2].toLowerCase();
      const openHour = rangeMatch[3].padStart(2, '0');
      const openMin = rangeMatch[4];
      const closeHour = rangeMatch[5].padStart(2, '0');
      const closeMin = rangeMatch[6];
      
      const startIdx = normalizedWeekdayOrder.indexOf(startDay);
      const endIdx = normalizedWeekdayOrder.indexOf(endDay);
      
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        const result = {};
        for (let i = startIdx; i <= endIdx; i++) {
          const dayKey = normalizedWeekdayMap[normalizedWeekdayOrder[i]];
          if (dayKey) {
            result[dayKey] = {
              opens: `${openHour}:${openMin}`,
              closes: `${closeHour}:${closeMin}`
            };
          }
        }
        return result;
      }
    }
    
    // Pattern 2: Per-day rows like "Pondělí 9:00–19:00"
    const perDayPattern = /(pondeli|utery|streda|ctvrtek|patek|sobota|nedele)\s+(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/gi;
    const perDayMatches = [...normalized.matchAll(perDayPattern)];
    
    if (perDayMatches.length > 0) {
      const result = {};
      for (const match of perDayMatches) {
        const day = match[1].toLowerCase();
        const openHour = match[2].padStart(2, '0');
        const openMin = match[3];
        const closeHour = match[4].padStart(2, '0');
        const closeMin = match[5];
        
        const dayKey = normalizedWeekdayMap[day];
        if (dayKey) {
          result[dayKey] = {
            opens: `${openHour}:${openMin}`,
            closes: `${closeHour}:${closeMin}`
          };
        }
      }
      if (Object.keys(result).length > 0) {
        return result;
      }
    }
    
    return null;
  }

  // Pre-extract phone and opening hours using heuristics
  const preExtractedPhone = extractCzechPhone(websiteText);
  const preExtractedHours = extractCzechOpeningHours(websiteText);
  
  if (preExtractedPhone) {
    console.log(`[ONBOARDING] Pre-extracted phone via regex: ${preExtractedPhone}`);
  }
  if (preExtractedHours) {
    console.log(`[ONBOARDING] Pre-extracted opening hours via heuristics:`, preExtractedHours);
  }

  // Step 6: Call OpenAI for extraction
  const extractionPrompt = `
You are extracting structured business data from text taken from a Czech website for a local service business (hair salon, barber, tyre shop, etc.).

IMPORTANT LANGUAGE RULES:
- The website content is in Czech.
- The JSON keys MUST be in English (e.g., "name", "services", "opening_hours").
- Service names MUST ALWAYS be in Czech – NEVER translate them to English.
- The "notes" field MUST be written in Czech – NEVER translate to English.

Return JSON with this EXACT structure:

{
  "name": string | null,
  "address": string | null,
  "phone": string | null,
  "email": string | null,
  "opening_hours": {
    "mon": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null,
    "tue": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null,
    "wed": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null,
    "thu": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null,
    "fri": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null,
    "sat": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null,
    "sun": { "opens": "HH:MM" | null, "closes": "HH:MM" | null } | null
  },
  "services": [
    {
      "name": string (ALWAYS IN CZECH),
      "slug": string (machine-readable, lowercase with underscores),
      "description": string | null,
      "duration_minutes": number | null,
      "price_from": number | null,
      "price_to": number | null,
      "is_core": boolean | null
    }
  ],
  "notes": string (ALWAYS IN CZECH)
}

Website text:
${websiteText}
`;

  let completion;
  try {
    completion = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'system',
          content: 'You are extracting structured business data from website text. Output only valid JSON, no markdown, no comments, no code fences.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ]
    });
  } catch (openaiError) {
    const errorMsg = openaiError?.message || 'Unknown OpenAI API error';
    if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ETIMEDOUT')) {
      throw new Error(`FETCH_FAILED: OpenAI API network error`);
    }
    throw new Error(`PARSE_FAILED: OpenAI API error`);
  }

  if (!completion || !completion.output || !Array.isArray(completion.output) || completion.output.length === 0) {
    throw new Error('PARSE_FAILED: Invalid OpenAI API response structure');
  }

  const outputText = completion.output[0].content[0].text;
  if (!outputText || typeof outputText !== 'string') {
    throw new Error('PARSE_FAILED: OpenAI API returned empty text');
  }

  let extractedData;
  try {
    extractedData = JSON.parse(outputText);
  } catch (parseError) {
    console.error('[ONBOARDING] Failed to parse OpenAI response:', parseError);
    throw new Error('PARSE_FAILED: Failed to parse extraction result as JSON');
  }

  // Step 7: Transform extracted data to ImportedBusinessData format
  const weekdayMap = {
    'mon': 'mon',
    'tue': 'tue',
    'wed': 'wed',
    'thu': 'thu',
    'fri': 'fri',
    'sat': 'sat',
    'sun': 'sun'
  };

  // Opening hours: ONLY include entries when we have valid opens+closes.
  // IMPORTANT: Do not generate "closed all week" fallback, because that overwrites existing hours in DB.
  const openingHours = [];
  if (extractedData.opening_hours && typeof extractedData.opening_hours === 'object') {
    for (const [weekdayKey, weekdayValue] of Object.entries(weekdayMap)) {
      const hours = extractedData.opening_hours[weekdayKey];
      if (hours && hours.opens && hours.closes) {
        openingHours.push({
          weekday: weekdayValue,
          opensAt: hours.opens,
          closesAt: hours.closes,
          closed: false,
        });
      }
    }
  }

  // Extract opening hours from JSON-LD (highest confidence) across crawled pages.
  function normalizeTimeToHHMM(t) {
    if (!t) return null;
    const s = String(t).trim();
    // "09:00" -> ok
    const m1 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m1) return `${m1[1].padStart(2, '0')}:${m1[2]}`;
    // "0900" or "900"
    const m2 = s.match(/^(\d{1,2})(\d{2})$/);
    if (m2) return `${m2[1].padStart(2, '0')}:${m2[2]}`;
    return null;
  }

  function weekdayFromSchemaDay(day) {
    if (!day) return null;
    const s = String(day);
    const tail = s.split('/').pop()?.toLowerCase() || s.toLowerCase();
    const map = {
      monday: 'mon',
      tuesday: 'tue',
      wednesday: 'wed',
      thursday: 'thu',
      friday: 'fri',
      saturday: 'sat',
      sunday: 'sun',
      mon: 'mon',
      tue: 'tue',
      wed: 'wed',
      thu: 'thu',
      fri: 'fri',
      sat: 'sat',
      sun: 'sun',
    };
    return map[tail] || null;
  }

  function extractJsonLdObjectsFromHtml(html) {
    const objects = [];
    if (!html) return objects;
    const rx = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = rx.exec(html)) !== null) {
      const raw = (m[1] || '').trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) objects.push(...parsed);
        else objects.push(parsed);
      } catch {
        // ignore
      }
    }
    return objects;
  }

  function extractOpeningHoursFromJsonLdPages(pages) {
    const result = {};
    let candidatesFound = 0;
    for (const p of Array.isArray(pages) ? pages : []) {
      if (!p?.html) continue;
      const html = p.html.length > 120000 ? p.html.slice(0, 120000) : p.html;
      const objs = extractJsonLdObjectsFromHtml(html);
      for (const obj of objs) {
        const spec = obj?.openingHoursSpecification || obj?.mainEntity?.openingHoursSpecification;
        if (!spec) continue;
        candidatesFound++;
        const specs = Array.isArray(spec) ? spec : [spec];
        for (const s of specs) {
          const opens = normalizeTimeToHHMM(s?.opens);
          const closes = normalizeTimeToHHMM(s?.closes);
          const dayOfWeek = s?.dayOfWeek;
          const days = Array.isArray(dayOfWeek) ? dayOfWeek : [dayOfWeek];
          for (const d of days) {
            const wk = weekdayFromSchemaDay(d);
            if (!wk || !opens || !closes) continue;
            result[wk] = { opens, closes };
          }
        }
      }
    }
    const validDays = Object.values(result).filter((v) => v?.opens && v?.closes).length;
    console.log(`[HOURS] jsonld candidates found: ${candidatesFound}, validDays: ${validDays}`);
    return { hours: result, validDays };
  }

  // Fresha fallback: try to extract hours from a Fresha page if discovered.
  async function extractOpeningHoursFromFreshaIfPossible(pages) {
    try {
      if (process.env.NODE_ENV === 'production') {
        console.log('[HOURS] Fresha hours extraction skipped in production.');
        return { hours: null, validDays: 0, reason: 'prod_skip' };
      }

      // Find a Fresha URL in crawled HTML (after link normalization fix, it should not be under base domain)
      const freshaRegex = /(https?:\/\/)?(www\.)?fresha\.com\/[^\s"'<>]+/gi;
      let freshaUrl = null;
      for (const p of Array.isArray(pages) ? pages : []) {
        if (!p?.html) continue;
        const match = String(p.html).match(freshaRegex);
        if (match && match[0]) {
          const raw = match[0].startsWith('http') ? match[0] : `https://${match[0].replace(/^www\./i, '')}`;
          freshaUrl = raw.replace(/^https?:\/\/www\./i, 'https://');
          break;
        }
      }

      if (!freshaUrl) {
        return { hours: null, validDays: 0, reason: 'no_fresha_url_found' };
      }

      console.log(`[HOURS] Fresha candidate URL: ${freshaUrl}`);

      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(freshaUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);

      // Try JSON-LD on Fresha page first
      const html = await page.content().catch(() => '');
      await browser.close();

      const { hours, validDays } = extractOpeningHoursFromJsonLdPages([{ html }]);
      console.log(`[HOURS] fresha hours extracted: validDays: ${validDays} (via jsonld)`);
      return { hours, validDays, reason: 'fresha_jsonld' };
    } catch (err) {
      console.log('[HOURS] Fresha hours extraction failed:', err?.message || String(err));
      return { hours: null, validDays: 0, reason: 'fresha_error' };
    }
  }

  // Helper function to normalize service name for comparison (same as normalizeServiceName)
  function normalizeServiceNameForComparison(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^klasick[ýá]\s+/i, '');
  }

  // Build services array from LLM extraction
  const llmServices = [];
  if (extractedData.services && Array.isArray(extractedData.services)) {
    for (const service of extractedData.services) {
      if (service.name && service.name.trim()) {
        llmServices.push({
          name: service.name.trim(),
          description: service.description || null,
          durationMinutes: service.duration_minutes || null,
          priceFrom: service.price_from || null,
          priceTo: service.price_to || null,
          isCore: service.is_core === true
        });
      }
    }
  }

  // Merge DOM-extracted services with LLM-extracted services
  // DOM values take precedence when names match
  const services = [...llmServices];
  const serviceMap = new Map();
  
  // Index LLM services by normalized name
  for (const service of llmServices) {
    const normalizedName = normalizeServiceNameForComparison(service.name);
    if (normalizedName) {
      serviceMap.set(normalizedName, service);
    }
  }

  // Merge DOM-extracted services
  for (const domService of domExtractedServices) {
    const normalizedName = normalizeServiceNameForComparison(domService.name);
    if (!normalizedName) continue;

    const existingService = serviceMap.get(normalizedName);
    
    if (existingService) {
      // Override existing service's numeric fields with DOM values (when non-null)
      if (domService.durationMinutes !== null && domService.durationMinutes !== undefined) {
        existingService.durationMinutes = domService.durationMinutes;
      }
      if (domService.priceFrom !== null && domService.priceFrom !== undefined) {
        existingService.priceFrom = domService.priceFrom;
      }
      if (domService.priceTo !== null && domService.priceTo !== undefined) {
        existingService.priceTo = domService.priceTo;
      }
      // Keep existing description if DOM doesn't have one
      if (!domService.description && existingService.description) {
        // Keep existing description
      } else if (domService.description) {
        existingService.description = domService.description;
      }
      console.log(`[ONBOARDING] Merged DOM data for service "${domService.name}": duration=${domService.durationMinutes}, price=${domService.priceFrom}-${domService.priceTo}`);
    } else {
      // New service from DOM - add it
      services.push(domService);
      serviceMap.set(normalizedName, domService);
      console.log(`[ONBOARDING] Added new service from DOM: "${domService.name}"`);
    }
  }

  // Post-process services: remove headers, strip footnotes, dedupe by canonical name, normalize prices.
  function canonicalizeServiceName(name) {
    if (!name) return '';
    return String(name)
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*[*†‡]+$/g, '') // trailing footnote markers
      .replace(/\s*[.:,-]+$/g, '') // trailing punctuation
      .trim();
  }

  function cleanServices(list) {
    const rawCount = Array.isArray(list) ? list.length : 0;
    const byName = new Map();
    let droppedHeaders = 0;
    let strippedFootnotes = 0;
    let merged = 0;

    const hasNumeric = (s) =>
      (s?.durationMinutes != null && Number.isFinite(s.durationMinutes)) ||
      (s?.priceFrom != null && Number.isFinite(s.priceFrom)) ||
      (s?.priceTo != null && Number.isFinite(s.priceTo));

    for (const s of Array.isArray(list) ? list : []) {
      const originalName = s?.name || '';
      const name = canonicalizeServiceName(originalName);
      if (!name) continue;

      if (name !== originalName.trim()) strippedFootnotes++;

      const candidate = {
        ...s,
        name,
        isCore: Boolean(hasNumeric(s)),
      };

      // Filter category/header rows: no duration and no price
      if (!hasNumeric(candidate)) {
        droppedHeaders++;
        continue;
      }

      const key = normalizeServiceNameForComparison(name);
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, candidate);
        continue;
      }

      // Merge: prefer the one with more numeric info, keep description if present
      const existingScore =
        (existing.durationMinutes != null ? 1 : 0) +
        (existing.priceFrom != null ? 1 : 0) +
        (existing.priceTo != null ? 1 : 0);
      const candScore =
        (candidate.durationMinutes != null ? 1 : 0) +
        (candidate.priceFrom != null ? 1 : 0) +
        (candidate.priceTo != null ? 1 : 0);

      const winner = candScore >= existingScore ? candidate : existing;
      const loser = winner === candidate ? existing : candidate;

      // carry over best fields
      if (winner.description == null && loser.description) winner.description = loser.description;
      if (winner.durationMinutes == null && loser.durationMinutes != null) winner.durationMinutes = loser.durationMinutes;
      if (winner.priceFrom == null && loser.priceFrom != null) winner.priceFrom = loser.priceFrom;
      if (winner.priceTo == null && loser.priceTo != null) winner.priceTo = loser.priceTo;

      byName.set(key, winner);
      merged++;
    }

    const cleaned = Array.from(byName.values());
    console.log(
      `[ONBOARDING] Services cleanup: raw=${rawCount} cleaned=${cleaned.length} droppedHeaders=${droppedHeaders} merged=${merged} strippedFootnotes=${strippedFootnotes}`
    );
    return cleaned;
  }

  // Merge pre-extracted data with OpenAI extraction (pre-extracted takes precedence)
  const finalPhone = preExtractedPhone || extractedData.phone || null;
  const finalOpeningHours = preExtractedHours || extractedData.opening_hours || null;
  
  // Prefer JSON-LD > pre-extracted heuristics > LLM extraction. Only include valid opens+closes entries.
  let finalOpeningHoursArray = openingHours;

  const jsonLdHours = extractOpeningHoursFromJsonLdPages(crawlResult.pages);
  if (jsonLdHours.validDays > 0) {
    finalOpeningHoursArray = [];
    for (const [weekdayKey, weekdayValue] of Object.entries(weekdayMap)) {
      const h = jsonLdHours.hours[weekdayKey];
      if (h?.opens && h?.closes) {
        finalOpeningHoursArray.push({ weekday: weekdayValue, opensAt: h.opens, closesAt: h.closes, closed: false });
      }
    }
  }

  if (preExtractedHours) {
    finalOpeningHoursArray = [];
    for (const [weekdayKey, weekdayValue] of Object.entries(weekdayMap)) {
      const hours = preExtractedHours[weekdayKey];
      if (hours && hours.opens && hours.closes) {
        finalOpeningHoursArray.push({
          weekday: weekdayValue,
          opensAt: hours.opens,
          closesAt: hours.closes,
          closed: false,
        });
      }
    }
  }

  // If we still have no hours and Fresha is detected, attempt a lightweight Fresha scrape in dev.
  if (finalOpeningHoursArray.length === 0 && crawlResult?.bookingProviders?.includes('fresha')) {
    const fresha = await extractOpeningHoursFromFreshaIfPossible(crawlResult.pages);
    if (fresha.validDays > 0 && fresha.hours) {
      finalOpeningHoursArray = [];
      for (const [weekdayKey, weekdayValue] of Object.entries(weekdayMap)) {
        const h = fresha.hours[weekdayKey];
        if (h?.opens && h?.closes) {
          finalOpeningHoursArray.push({ weekday: weekdayValue, opensAt: h.opens, closesAt: h.closes, closed: false });
        }
      }
      console.log(`[HOURS] Using Fresha hours. validDays=${fresha.validDays} reason=${fresha.reason}`);
    } else {
      console.log(`[HOURS] Fresha hours unavailable. reason=${fresha.reason}`);
    }
  }
  const validHoursCount = finalOpeningHoursArray.filter((h) => h?.opensAt && h?.closesAt).length;
  if (validHoursCount === 0) {
    console.log('[ONBOARDING] No opening hours extracted; will skip opening_hours upsert (preserving existing).');
    finalOpeningHoursArray = [];
  } else {
    console.log(`[ONBOARDING] Opening hours extracted: validDays=${validHoursCount}`);
  }

  // Merge deterministic contact extraction with LLM extraction
  // Priority: deterministic > LLM > pre-extracted regex
  const mergedContact = mergeContactData(deterministicContact, {
    name: extractedData.name,
    address: extractedData.address,
    phone: extractedData.phone,
    email: extractedData.email,
  });
  
  // Final phone: deterministic > LLM > pre-extracted regex
  const finalPhoneMerged = mergedContact.phone || finalPhone;
  // Final email: deterministic > LLM
  const finalEmail = mergedContact.email || extractedData.email || null;
  // Final address: deterministic > LLM (prefer specific addresses over generic like "Praha a Brno")
  let finalAddress = mergedContact.address || extractedData.address || null;
  // If LLM gave a very generic address but deterministic found a real one, use deterministic
  if (deterministicContact.address && extractedData.address && 
      extractedData.address.length < 20 && deterministicContact.address.length > extractedData.address.length) {
    finalAddress = deterministicContact.address;
    console.log(`[ONBOARDING] Using more specific deterministic address: "${finalAddress}" over generic LLM: "${extractedData.address}"`);
  }

  // Pick best business name (avoid generic names like "Prémiové kadeřnictví")
  const pickedName = pickBusinessName({
    htmlPages: crawlResult.pages,
    url,
    extractedName: extractedData.name || null,
  });
  const pickedNameVal = pickedName?.name || (extractedData.name || null);
  console.log('[ONBOARDING] Name selection:', {
    chosen: pickedNameVal,
    source: pickedName.source,
    score: pickedName.score,
    extracted: extractedData.name || null,
    extractedScore: extractedData.name ? scoreBusinessName(extractedData.name, url) : null,
    topCandidates: pickedName.topCandidates,
  });

  const importedData = {
    profile: {
      name: pickedNameVal,
      address: finalAddress,
      phone: finalPhoneMerged,
      email: finalEmail,
      website: url
    },
    services: cleanServices(services),
    openingHours: finalOpeningHoursArray
  };

  console.log(`[ONBOARDING] Successfully extracted data: profile=${!!importedData.profile.name}, services=${services.length}, openingHours=${finalOpeningHoursArray.length}`);
  console.log(`[ONBOARDING] Final profile: name="${importedData.profile.name}", phone="${importedData.profile.phone}", email="${importedData.profile.email}", address="${importedData.profile.address}"`);

  return importedData;
}

/**
 * Helper function to generate slug from Czech service name
 * Converts "Pánský střih" → "pansky_strih"
 * Matches the logic used in extract_profile endpoint
 */
function makeSlugFromName(name) {
  if (!name || typeof name !== 'string') return '';
  
  return name
    .toLowerCase()
    .normalize('NFD') // Decompose accented characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s-]/g, '') // Remove non-alphanumeric except spaces and hyphens
    .trim()
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/-+/g, '_') // Replace hyphens with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
}

/**
 * Applies imported business data to Supabase tables.
 *
 * IMPORTANT: This version uses:
 * - businesses: id, name
 * - business_profile: business_id, name, address, phone, email, website_url
 * - services: business_id, name, slug, description, duration_minutes,
 *             price_from, price_to, is_active
 * - opening_hours: business_id, weekday, opens_at, closes_at
 *
 * @param {any} supabase - Supabase client instance
 * @param {string} businessId - Business UUID
 * @param {ImportedBusinessData} data - Imported business data
 */
async function applyImportedBusinessData(supabase, businessId, data) {
    if (!supabase) throw new Error('supabase client is required');
    if (!businessId) throw new Error('businessId is required');
    if (!data || !data.profile) throw new Error('data.profile is required');
  
    console.log(`[ONBOARDING] Applying imported data for business ${businessId}`);
    console.log('[ONBOARDING] Imported data preview:', JSON.stringify(data, null, 2));
  
    //
    // STEP 0: Fetch existing profile to implement coalesce logic
    // ---------------------------------------------------------
    // We don't want to overwrite existing non-null values with null
    //
    const { data: existingProfile } = await supabase
      .from('business_profile')
      .select('*')
      .eq('business_id', businessId)
      .maybeSingle();
    
    const { data: existingBusiness } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle();
    
    console.log(`[ONBOARDING] Existing profile:`, existingProfile ? {
      name: existingProfile.name,
      phone: existingProfile.phone,
      email: existingProfile.email,
      address: existingProfile.address,
    } : '(none)');

    //
    // STEP 1: Update `businesses` table
    // --------------------------------
    // We ONLY update the name column if new value is non-empty
    // NOTE: businesses.phone is separate from business_profile.phone
    // NOTE: businesses.vapi_phone is for Twilio/Vapi routing - NEVER touch it here
    //
    const websiteForScoring = data?.profile?.website || null;
    const newName = data.profile.name?.trim();
    const existingName = existingBusiness?.name?.trim();

    const shouldUpdateName =
      Boolean(newName) &&
      (newName !== existingName) &&
      (
        !existingName ||
        (websiteForScoring && isGenericBusinessName(existingName, websiteForScoring) && scoreBusinessName(newName, websiteForScoring) > scoreBusinessName(existingName, websiteForScoring))
      );

    // Update name if it's new, or if existing looks generic and new is higher quality
    if (shouldUpdateName) {
      const { error: businessError } = await supabase
        .from('businesses')
        .update({ name: newName })
        .eq('id', businessId);
    
      if (businessError) {
        console.error('[ONBOARDING] Error updating businesses:', businessError);
        throw new Error(`Failed to update business: ${businessError.message}`);
      }
      console.log(`[ONBOARDING] Updated business name: "${existingName}" → "${newName}" (qualityScore ${websiteForScoring ? scoreBusinessName(newName, websiteForScoring) : 'n/a'})`);
    } else {
      console.log(`[ONBOARDING] Skipping business name update (no new value, same, or existing is higher quality)`);
    }

    //
    // STEP 1b: Update `business_profile` table with COALESCE logic
    // ------------------------------------------------------------
    // Update profile fields (address, phone, email, website_url) to match
    // what the Nastavení podniku page reads from.
    // 
    // IMPORTANT: Only update fields where imported value is non-null/non-empty.
    // This prevents crawler from wiping existing data with nulls.
    //
    // NOTE: This phone is the CONTACT phone for customers to call.
    // It is DIFFERENT from businesses.vapi_phone which is the Twilio number
    // that routes inbound calls to the IVA system.
    //
    if (data.profile) {
      // Helper to coalesce: use new value only if non-empty, else keep existing
      const coalesce = (newVal, existingVal) => {
        const newTrimmed = typeof newVal === 'string' ? newVal.trim() : newVal;
        if (newTrimmed && newTrimmed !== '') {
          return newTrimmed;
        }
        return existingVal ?? null;
      };
      
      // Decide name update: allow replacing generic existing name with higher-quality imported one.
      const existingProfileName = existingProfile?.name || null;
      const importedProfileName = data.profile.name || null;
      const nameToSave =
        websiteForScoring && importedProfileName
          ? (
              !existingProfileName
                ? importedProfileName
                : (
                    isGenericBusinessName(existingProfileName, websiteForScoring) && scoreBusinessName(importedProfileName, websiteForScoring) > scoreBusinessName(existingProfileName, websiteForScoring)
                      ? importedProfileName
                      : existingProfileName
                  )
            )
          : coalesce(importedProfileName, existingProfileName);

      const profileData = {
        business_id: businessId,
        name: nameToSave,
        address: coalesce(data.profile.address, existingProfile?.address),
        phone: coalesce(data.profile.phone, existingProfile?.phone),
        email: coalesce(data.profile.email, existingProfile?.email),
        website_url: coalesce(data.profile.website, existingProfile?.website_url),
        updated_at: new Date().toISOString()
      };
      
      // Log what's being updated vs preserved
      const changes = [];
      if (profileData.name && profileData.name !== existingProfile?.name) changes.push(`name: "${profileData.name}"`);
      if (data.profile.address && data.profile.address !== existingProfile?.address) changes.push(`address: "${data.profile.address}"`);
      if (data.profile.phone && data.profile.phone !== existingProfile?.phone) changes.push(`phone: "${data.profile.phone}"`);
      if (data.profile.email && data.profile.email !== existingProfile?.email) changes.push(`email: "${data.profile.email}"`);
      if (data.profile.website && data.profile.website !== existingProfile?.website_url) changes.push(`website: "${data.profile.website}"`);
      
      if (changes.length > 0) {
        console.log(`[ONBOARDING] Profile changes: ${changes.join(', ')}`);
      } else {
        console.log(`[ONBOARDING] No profile changes (all values same or null)`);
      }

      const { error: profileError } = await supabase
        .from('business_profile')
        .upsert(profileData, {
          onConflict: 'business_id'
        });

      if (profileError) {
        console.error('[ONBOARDING] Error updating profile:', profileError);
        throw new Error(`Failed to update business profile: ${profileError.message}`);
      }

      console.log(`[ONBOARDING] Updated business_profile for business ${businessId}`);
    }
  
    //
    // STEP 2: Save services (by business_id + slug)
// -----------------------------------------------
if (Array.isArray(data.services) && data.services.length > 0) {
    // 1) Load existing services BEFORE deletion to preserve is_bookable
    const { data: existingServices, error: existingError } = await supabase
      .from('services')
      .select('id, slug, is_bookable')
      .eq('business_id', businessId);
  
    if (existingError) {
      console.warn('[ONBOARDING] Could not load existing services for is_bookable preservation:', existingError);
    }
  
    // Build lookup map by slug
    const existingBySlug = new Map();
    if (existingServices && Array.isArray(existingServices)) {
      for (const existing of existingServices) {
        if (existing.slug) {
          existingBySlug.set(existing.slug, existing);
        }
      }
    }
  
    // 2) Build raw payload, preserving is_bookable from existing services
    const rawServices = data.services.map((s, index) => {
      const baseName = s.name || `Služba z webu ${index + 1}`;
  
      // Same slug logic as elsewhere
      const slug = makeSlugFromName(baseName) || `service-${index + 1}`;
  
      // Preserve is_bookable if service already exists, otherwise default to false
      const existingService = existingBySlug.get(slug);
      const preservedIsBookable = existingService ? existingService.is_bookable : false;
  
      return {
        business_id: businessId,
        name: baseName,
        slug,
        description: s.description ?? null,
        duration_minutes: s.durationMinutes ?? null,
        price_from: s.priceFrom ?? null,
        price_to: s.priceTo ?? null,
        is_active: true,
        is_bookable: preservedIsBookable,
      };
    });
  
    // 3) Deduplicate by (business_id, slug) to avoid 23505 inside a single insert
    const map = new Map(); // key: `${business_id}:${slug}`
    for (const svc of rawServices) {
      const key = `${svc.business_id}:${svc.slug}`;
      // last one wins – they all come from the same crawl anyway
      map.set(key, svc);
    }
    const servicesPayload = Array.from(map.values());
  
    console.log(
      `[ONBOARDING] Saving ${servicesPayload.length} services (deduped from ${rawServices.length}) for business ${businessId}`
    );
  
    // 4) Upsert (no deletion - upsert handles updates and inserts)
    // This preserves existing services that weren't in the crawl
    const { error: servicesError } = await supabase
      .from('services')
      .upsert(servicesPayload, {
        onConflict: 'business_id,slug',
      });
  
    if (servicesError) {
      console.error('[ONBOARDING] Error upserting services:', servicesError);
      throw new Error(`Failed to upsert services: ${servicesError.message}`);
    }
  
    console.log(
      `[ONBOARDING] Upserted ${servicesPayload.length} services for business ${businessId} (preserved is_bookable flags)`
    );
  } else {
    console.log('[ONBOARDING] No services supplied from crawler');
  }
      
    //
    // STEP 3: Upsert opening hours (by business_id + weekday)
    // -------------------------------------------------------
    const validHours = Array.isArray(data.openingHours)
      ? data.openingHours.filter((oh) => oh && oh.opensAt && oh.closesAt)
      : [];

    if (validHours.length > 0) {
      const openingPayload = validHours.map((oh) => {
        return {
          business_id: businessId,
          weekday: oh.weekday,
          opens_at: oh.opensAt ?? null,
          closes_at: oh.closesAt ?? null,
        };
      });
  
      const { error: openingError } = await supabase
        .from('opening_hours')
        .upsert(openingPayload, { onConflict: 'business_id,weekday' });
  
      if (openingError) {
        console.error('[ONBOARDING] Error upserting opening hours:', openingError);
        throw new Error(`Failed to upsert opening hours: ${openingError.message}`);
      }
  
      console.log(
        `[ONBOARDING] Upserted ${openingPayload.length} opening hours for business ${businessId}`
      );
    } else {
      console.log('[ONBOARDING] No opening hours extracted; skipping opening_hours upsert (preserving existing).');
    }
  
    console.log(`[ONBOARDING] Successfully applied imported data for business ${businessId}`);
  }
  
  export { applyImportedBusinessData, crawlBusinessWebsite };
  