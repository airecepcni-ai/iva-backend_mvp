import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Supabase client (same pattern as index.js)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

/**
 * Simple heuristic: check which important fields are missing or weak.
 * @param {any} profile parsedProfile from extract_profile
 * @returns {string[]} list of missing field names
 */
export function detectMissingFields(profile) {
  const missing = [];

  if (!profile?.phone) missing.push('phone');
  if (!profile?.email) missing.push('email');
  if (!profile?.opening_hours || Object.keys(profile.opening_hours || {}).length === 0) {
    missing.push('opening_hours');
  }
  if (!Array.isArray(profile?.services) || profile.services.length === 0) {
    missing.push('services');
  }
  if (!Array.isArray(profile?.locations) || profile.locations.length === 0) {
    missing.push('locations');
  }
  if (!Array.isArray(profile?.booking_providers) || profile.booking_providers.length === 0) {
    missing.push('booking_providers');
  } else {
    console.log('[AGENTIC] Booking providers already present → skipping booking_providers in missing_fields.');
  }

  // You can add more as needed (faq, payment_methods, parking, etc.)
  return missing;
}

/**
 * Build a compact summary of pages for the LLM:
 * [{ full_url, path, depth, has_booking_provider, text_snippet }]
 */
export function buildPageSummaries(crawledPages, maxPages = 40, maxSnippetLen = 260) {
  if (!Array.isArray(crawledPages)) return [];

  return crawledPages
    .slice(0, maxPages)
    .map((p) => {
      const text = (p.text || p.html || '').replace(/\s+/g, ' ').trim();
      const snippet = text.length > maxSnippetLen ? text.slice(0, maxSnippetLen) + '…' : text;

      // Extract path from URL
      let path = '/';
      try {
        const urlObj = new URL(p.url);
        path = urlObj.pathname || '/';
      } catch {
        // If URL parsing fails, try to extract path manually
        const match = p.url.match(/https?:\/\/[^\/]+(\/.*)?/);
        if (match && match[1]) {
          path = match[1];
        }
      }

      return {
        full_url: p.url,
        path: path,
        depth: p.depth ?? null,
        has_booking_provider: !!p.bookingProvider,
        text_snippet: snippet
      };
    });
}

/**
 * Call OpenAI to get an agentic crawl plan.
 *
 * @param {Object} params
 * @param {string} params.businessId
 * @param {any} params.profile parsedProfile
 * @param {Array} params.crawledPages array of { url, depth, text/html, bookingProvider? }
 */
export async function generateCrawlPlan({ businessId, profile, crawledPages }) {
  const missingFields = detectMissingFields(profile);
  const pageSummaries = buildPageSummaries(crawledPages || []);

  if (missingFields.length === 0) {
    // Nothing important missing; no need to ask the model.
    console.log('[AGENTIC] All key fields present, skipping crawl plan.');
    return null;
  }

  const systemPrompt = `
You are an expert web crawling strategist for a virtual receptionist product.
The crawler has already visited some pages. We have a parsed business profile and a list of visited pages.
Your task is to suggest a SMALL set of additional internal URLs to crawl to fill missing information.

CRITICAL CONSTRAINTS:
- You are given a list of 'pages', each with:
  - full_url: the complete URL
  - path: the relative path (e.g., "/rezervace", "/cenik-kadernictvi-brno")
  - text_snippet: a preview of the page content
- You are NOT allowed to invent new URLs.
- Every suggested_url MUST be exactly one of the 'path' values from the provided list of pages.
- If no page looks helpful for filling the missing fields, return an empty array.

PRIORITIZATION:
- When missing_fields contains "booking_providers":
  - Prioritize paths or text snippets containing words like:
    "rezervace", "reservation", "booking", "book", "order",
    "fresha", "bookio", "timify", "cal", "iframe", "online"
  - Include up to 8 of the most relevant paths from the provided pages list.
- For other missing fields (phone, email, opening_hours, services, locations):
  - Prioritize paths or text snippets containing relevant keywords.
  - Only suggest paths that actually exist in the provided pages list.

OUTPUT FORMAT (strict JSON):
{
  "suggested_urls": ["/some-path", "/another-path"],
  "notes": "Short explanation of why these paths were chosen",
  "missing_fields": ["booking_providers"]
}

Remember: Only use paths from the provided pages list. Do not invent new paths.
`.trim();
 
  const userPayload = {
    profile: {
      name: profile?.name,
      address: profile?.address,
      phone: profile?.phone,
      email: profile?.email,
      has_opening_hours: !!profile?.opening_hours && Object.keys(profile.opening_hours || {}).length > 0,
      locations: profile?.locations || [],
      booking_providers: profile?.booking_providers || [],
      services_count: Array.isArray(profile?.services) ? profile.services.length : 0
    },
    missing_fields: missingFields,
    pages: pageSummaries
  };

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_AGENTIC_MODEL || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Given this data, suggest where we should crawl next to fill the missing fields.\n\n${JSON.stringify(
          userPayload
        )}`
      }
    ]
  });

  let plan;
  try {
    plan = JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch (err) {
    console.error('[AGENTIC] Failed to parse crawl plan JSON:', err);
    plan = {
      missing_fields: missingFields,
      suggested_urls: [],
      notes: 'Failed to parse model response'
    };
  }

  // Post-filter: ensure suggested_urls only contain paths from actual crawled pages
  const allowedPaths = new Set(
    crawledPages
      .map((p) => {
        try {
          const urlObj = new URL(p.url);
          return urlObj.pathname || '/';
        } catch {
          // Fallback: try to extract path manually
          const match = p.url.match(/https?:\/\/[^\/]+(\/.*)?/);
          return (match && match[1]) ? match[1] : '/';
        }
      })
      .filter(Boolean)
  );

  // Normalize path helper
  function normalizePath(p) {
    if (!p) return null;
    try {
      // if it's a full URL, convert to pathname
      if (p.startsWith('http://') || p.startsWith('https://')) {
        return new URL(p).pathname || '/';
      }
      // ensure leading slash
      return p.startsWith('/') ? p : `/${p}`;
    } catch {
      return null;
    }
  }

  // Filter suggested URLs to only include paths from crawled pages
  const filtered = [];
  const rawSuggested = Array.isArray(plan.suggested_urls) ? plan.suggested_urls : [];
  
  for (const raw of rawSuggested) {
    const path = normalizePath(raw);
    if (!path) continue;
    
    if (allowedPaths.has(path)) {
      filtered.push(path);
    } else {
      console.log('[AGENTIC] Discarding suggested url not in crawled pages:', raw, '(normalized:', path, ')');
    }
  }

  // Deduplicate
  const unique = [...new Set(filtered)];

  const notes = typeof plan.notes === 'string' ? plan.notes : '';

  const record = {
    business_id: businessId,
    missing_fields: missingFields,
    suggested_urls: unique,
    notes,
    raw_llm_response: plan
  };

  const { data, error } = await supabase
    .from('iva_crawl_plans')
    .insert(record)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[AGENTIC] Failed to save crawl plan:', error);
  } else {
    console.log('[AGENTIC] Saved crawl plan:', {
      id: data?.id,
      missing_fields: missingFields,
      suggested_urls: unique,
      filtered_from: rawSuggested.length,
      final_count: unique.length
    });
  }

  return { id: data?.id, ...record };
}

/**
 * Get the latest crawl plan for a business.
 * @param {string} businessId
 * @returns {Promise<Object|null>} Latest crawl plan or null
 */
export async function getLatestCrawlPlan(businessId) {
  if (!businessId) return null;

  try {
    const { data, error } = await supabase
      .from('iva_crawl_plans')
      .select('id, created_at, missing_fields, suggested_urls, notes')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[AGENTIC] getLatestCrawlPlan error:', error);
      return null;
    }

    return data || null;
  } catch (err) {
    console.error('[AGENTIC] getLatestCrawlPlan exception:', err);
    return null;
  }
}

/**
 * Build forced URLs from a crawl plan's suggested_urls.
 * @param {Object} params
 * @param {string} params.baseUrl - Base URL of the website
 * @param {Object} params.plan - Crawl plan object with suggested_urls
 * @returns {string[]} Array of full URLs to force-crawl
 */
export function buildForcedUrlsFromPlan({ baseUrl, plan }) {
  if (!plan) return [];
  const suggested = Array.isArray(plan.suggested_urls)
    ? plan.suggested_urls
    : [];

  if (!suggested.length) return [];

  let root;
  try {
    root = new URL(baseUrl);
  } catch {
    console.warn('[AGENTIC] buildForcedUrlsFromPlan invalid baseUrl:', baseUrl);
    return [];
  }

  const forced = new Set();

  for (const raw of suggested) {
    if (!raw || typeof raw !== 'string') continue;

    let full;
    try {
      // If it's already absolute (starts with http), just use it
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        full = new URL(raw);
      } else {
        // Treat it as a path relative to base
        const normalized = raw.startsWith('/') ? raw : `/${raw}`;
        full = new URL(normalized, root.origin);
      }

      // Only same-origin URLs
      if (full.origin !== root.origin) continue;

      forced.add(full.toString());
    } catch {
      // ignore invalid URL
    }
  }

  return Array.from(forced);
}

