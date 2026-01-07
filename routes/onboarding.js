import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { crawlBusinessWebsite, applyImportedBusinessData } from '../lib/importFromWeb.js';
import { chunkText, cleanText } from '../utils/textUtils.js';
import OpenAI from 'openai';

const router = express.Router();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * POST /api/onboarding/import_from_web
 * 
 * Crawls a business website and imports structured data (name, address, phone, services, opening hours).
 * 
 * Body:
 * - url: Website URL to crawl - REQUIRED
 * - businessId: Business ID (UUID) - REQUIRED (also read from x-tenant-id header)
 * 
 * Headers:
 * - x-tenant-id: business ID (UUID) - REQUIRED
 * 
 * Response:
 * - success: boolean
 * - message_cs: Czech message for UI
 * - error?: error code
 * - subscriptionRequired?: boolean (if subscription check failed)
 */
router.post('/import_from_web', async (req, res) => {
  try {
    const { url } = req.body || {};
    
    // Read business ID from header or body
    const businessId = req.headers['x-tenant-id'] || req.body?.businessId;

    if (!businessId || typeof businessId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_TENANT_ID',
        message_cs: 'Chybí identifikátor firmy. Zkuste se znovu přihlásit.',
      });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_URL',
        message_cs: 'Zadejte prosím URL vašeho webu.',
      });
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch {
      return res.status(400).json({
        success: false,
        error: 'INVALID_URL',
        message_cs: 'Zadejte prosím platnou URL adresu (např. https://example.com).',
      });
    }

    console.log('[ONBOARDING] Import request:', { businessId, url: parsedUrl.href });

    // Check subscription status
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('id, name, is_subscribed')
      .eq('id', businessId)
      .single();

    if (businessError || !business) {
      console.error('[ONBOARDING] Business not found:', businessId, businessError);
      return res.status(404).json({
        success: false,
        error: 'BUSINESS_NOT_FOUND',
        message_cs: 'Podnik nebyl nalezen. Zkuste se znovu přihlásit.',
      });
    }

    // Require subscription for web import
    if (!business.is_subscribed) {
      console.log('[ONBOARDING] Subscription required for business:', businessId);
      return res.status(402).json({
        success: false,
        error: 'subscription_required',
        subscriptionRequired: true,
        message_cs: 'Pro analýzu webu je potřeba mít aktivní předplatné.',
      });
    }

    // Crawl website and extract data
    console.log('[ONBOARDING] Starting crawl for subscribed business:', businessId);
    
    let importedData;
    try {
      importedData = await crawlBusinessWebsite(parsedUrl.href, {
        businessId,
        supabase,
        openai,
        chunkText,
        cleanText,
      });
    } catch (crawlError) {
      const errorMessage = crawlError?.message || String(crawlError);
      console.error('[ONBOARDING] Crawl error:', errorMessage);

      if (errorMessage.includes('PLAYWRIGHT_MISSING')) {
        return res.status(503).json({
          success: false,
          error: 'PLAYWRIGHT_MISSING',
          message_cs: 'Spouštění Playwright pro crawling je momentálně nedostupné. Zkuste to prosím za chvíli.',
        });
      }

      if (errorMessage.includes('INVALID_URL')) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_URL',
          message_cs: 'Zadejte prosím platnou URL adresu.',
        });
      }

      if (errorMessage.includes('FETCH_FAILED')) {
        return res.status(502).json({
          success: false,
          error: 'FETCH_FAILED',
          message_cs: 'Nepodařilo se načíst webovou stránku. Zkontrolujte, že URL je správná a stránka je dostupná.',
        });
      }

      if (errorMessage.includes('PARSE_FAILED')) {
        return res.status(422).json({
          success: false,
          error: 'PARSE_FAILED',
          message_cs: 'Nepodařilo se analyzovat obsah webu. Zkuste to prosím znovu později.',
        });
      }

      return res.status(500).json({
        success: false,
        error: 'CRAWL_ERROR',
        message_cs: 'Při analýze webu došlo k chybě. Zkuste to prosím znovu později.',
      });
    }

    // Apply imported data to database
    try {
      await applyImportedBusinessData(supabase, businessId, importedData);
    } catch (applyError) {
      console.error('[ONBOARDING] Apply error:', applyError);
      return res.status(500).json({
        success: false,
        error: 'SAVE_ERROR',
        message_cs: 'Data byla načtena, ale nepodařilo se je uložit. Zkuste to prosím znovu.',
      });
    }

    // Success response
    const servicesCount = importedData.services?.length || 0;
    const hasOpeningHours = importedData.openingHours?.some(oh => !oh.closed) || false;
    
    console.log('[ONBOARDING] Import successful:', {
      businessId,
      name: importedData.profile?.name,
      servicesCount,
      hasOpeningHours,
    });

    return res.status(200).json({
      success: true,
      message_cs: `Data z webu byla úspěšně načtena a uložena. Nalezeno ${servicesCount} služeb.`,
      imported: {
        name: importedData.profile?.name || null,
        servicesCount,
        hasOpeningHours,
      },
    });
  } catch (err) {
    console.error('[ONBOARDING] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Při analýze webu došlo k neočekávané chybě. Zkuste to prosím znovu.',
    });
  }
});

/**
 * GET /api/onboarding/test_extract
 * 
 * DEV-ONLY endpoint to test contact extraction for a URL without modifying the database.
 * Returns the extracted profile data for validation.
 * 
 * Query params:
 * - url: Website URL to test
 * - businessId: Business ID (optional, uses test ID if not provided)
 */
router.get('/test_extract', async (req, res) => {
  // Only allow in development
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Endpoint disabled in production' });
  }

  try {
    const { url } = req.query;
    
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'MISSING_URL',
        hint: 'Usage: GET /api/onboarding/test_extract?url=https://example.com',
      });
    }

    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch {
      return res.status(400).json({
        error: 'INVALID_URL',
        message: 'Please provide a valid URL (e.g., https://example.com)',
      });
    }

    console.log('[TEST_EXTRACT] Testing extraction for:', parsedUrl.href);

    // Import the extraction utilities
    const { extractContactFromPages } = await import('../lib/extractContact.js');
    const { crawlWebsiteWithPlaywright } = await import('../crawlers/playwrightCrawler.js');
    const { cleanText, chunkText } = await import('../utils/textUtils.js');

    // For test endpoint, use a minimal mock supabase that skips DB operations
    const mockSupabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'test mode - skipped' } }) }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      }),
    };

    // Crawl the website (limited to contact-related pages for speed)
    const crawlResult = await crawlWebsiteWithPlaywright({
      baseUrl: parsedUrl.href,
      maxDepth: 1,
      maxPages: 5,
      excludePaths: [],
      businessId: 'test-extract-00000000-0000-0000-0000-000000000000',
      sourceId: 'test-extract-00000000-0000-0000-0000-000000000001',
      forcedUrls: [],
      chunkText,
      cleanText,
      supabase: mockSupabase, // Mock supabase to skip DB operations
    });

    console.log(`[TEST_EXTRACT] Crawled ${crawlResult.pagesIndexed} pages`);

    // Extract contacts
    const contacts = extractContactFromPages(crawlResult.pages || []);

    // Return the extracted data
    return res.status(200).json({
      ok: true,
      url: parsedUrl.href,
      pagesCrawled: crawlResult.pagesIndexed,
      pagesWithHtml: (crawlResult.pages || []).filter(p => p.html).length,
      extractedContact: {
        phone: contacts.phone,
        email: contacts.email,
        address: contacts.address,
        sources: contacts.sources,
      },
      pages: (crawlResult.pages || []).map(p => ({
        url: p.url,
        hasHtml: !!p.html,
        htmlLength: p.html?.length || 0,
      })),
    });
  } catch (err) {
    console.error('[TEST_EXTRACT] Error:', err);
    return res.status(500).json({
      error: 'EXTRACTION_ERROR',
      message: err.message,
    });
  }
});

export default router;

