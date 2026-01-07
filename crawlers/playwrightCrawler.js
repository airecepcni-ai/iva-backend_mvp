import { chromium, errors as PlaywrightErrors } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';

const DEBUG_CRAWL = process.env.DEBUG_CRAWL === 'true';
const logCrawl = (...args) => {
  if (DEBUG_CRAWL) {
    console.log('[CRAWL]', ...args);
  }
};

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Priority link detection keywords and patterns
const PRIORITY_LINK_TEXTS = [
  'kontakt',
  'contact',
  'contacts',
  'kontakty',
  'rezervace',
  'rezervovat',
  'booking',
  'book now',
  'appointment',
  'reservation',
  'ceník',
  'cenník',
  'ceny',
  'price list',
  'prices',
  'menu',
  'služby',
  'services',
];

const PRIORITY_HREF_PATTERNS = [
  /\/kontakt/i,
  /\/contact/i,
  /\/contacts/i,
  /\/rezervace/i,
  /\/booking/i,
  /\/book/i,
  /\/appointment/i,
  /\/reservation/i,
  /\/cenik/i,
  /\/cennik/i,
  /\/ceny/i,
  /\/price/i,
  /\/menu/i,
  /\/sluzby/i,
  /\/services/i,
];

// Booking provider detection patterns
const BOOKING_PATTERNS = [
  { id: 'fresha', patterns: ['fresha.com', 'widget.fresha.com'] },
  { id: 'reserva', patterns: ['reserva.cz', 'reservaonline'] },
  { id: 'simplebook', patterns: ['simplebook', 'simplybook.me'] },
  { id: 'timely', patterns: ['gettimely', 'book.gettimely.com'] },
  { id: 'rever', patterns: ['rever.io', 'reverapp'] },
  { id: 'other_booking', patterns: ['iframe', 'booking', 'rezervace'] } // generic heuristic
];

/**
 * Discover URLs from sitemap.xml
 * @param {string} baseUrl - Base URL of the website
 * @param {number} maxPages - Maximum number of URLs to return
 * @param {string[]} excludePaths - Path patterns to exclude
 * @returns {Promise<string[]>} Array of discovered URLs
 */
async function discoverUrlsFromSitemap(baseUrl, maxPages, excludePaths = []) {
  try {
    const sitemapUrl = new URL('/sitemap.xml', baseUrl).toString();
    console.log('[SITEMAP] Trying', sitemapUrl);

    const res = await fetch(sitemapUrl);
    if (!res.ok) {
      console.log('[SITEMAP] No sitemap (status', res.status, ')');
      return [];
    }

    const xml = await res.text();
    const parser = new XMLParser();
    const data = parser.parse(xml);

    // sitemap can be either:
    // - <urlset><url><loc>...</loc></url>...</urlset>
    // - <sitemapindex><sitemap><loc>...</loc></sitemap>...</sitemapindex> (we'll only support the first for now)
    let locs = [];

    if (data.urlset && Array.isArray(data.urlset.url)) {
      locs = data.urlset.url
        .map((u) => u.loc)
        .filter(Boolean);
    } else if (data.urlset && data.urlset.url && data.urlset.url.loc) {
      locs = [data.urlset.url.loc];
    } else {
      console.log('[SITEMAP] Unrecognized sitemap structure');
      return [];
    }

    const base = new URL(baseUrl);
    const baseHostname = base.hostname.replace(/^www\./, '');

    const normalized = [];
    for (const loc of locs) {
      try {
        const url = new URL(loc);
        const hostname = url.hostname.replace(/^www\./, '');

        if (hostname !== baseHostname) continue;

        const pathname = url.pathname || '/';
        if (excludePaths.some((p) => pathname.startsWith(p))) continue;

        normalized.push(url.toString());
      } catch (e) {
        // ignore invalid loc
      }
    }

    const limited = normalized.slice(0, maxPages || 200);
    console.log('[SITEMAP] Discovered', limited.length, 'URLs from sitemap.xml');
    return limited;
  } catch (err) {
    console.log('[SITEMAP] Error fetching/processing sitemap:', err.message);
    return [];
  }
}

/**
 * Detect booking providers from URL and HTML content
 * @param {string} url - Page URL
 * @param {string} html - HTML content
 * @returns {string[]} Array of detected provider IDs
 */
function detectBookingProviders(url, html) {
  const found = new Set();
  const haystack = (url + '\n' + (html || '')).toLowerCase();

  for (const provider of BOOKING_PATTERNS) {
    const hit = provider.patterns.some((p) => haystack.includes(p.toLowerCase()));
    if (hit) found.add(provider.id);
  }

  return Array.from(found);
}

/**
 * Playwright-based website crawler for IVA
 * Replaces Cheerio-based crawler to handle JavaScript-rendered content
 * 
 * @param {Object} options
 * @param {string} options.baseUrl - Starting URL for crawl
 * @param {number} options.maxDepth - Maximum crawl depth
 * @param {number} options.maxPages - Maximum pages to crawl
 * @param {string[]} options.excludePaths - Path patterns to exclude
 * @param {string} options.businessId - Business UUID
 * @param {string} options.sourceId - Source UUID from kb_sources
 * @param {string[]} options.forcedUrls - URLs to force-crawl (e.g., /kontakt)
 * @param {Function} options.chunkText - Text chunking function
 * @param {Function} options.cleanText - Text cleaning function
 * @param {Object} options.supabase - Supabase client instance
 * @returns {Promise<{pagesIndexed: number, chunksCreated: number}>}
 */
export async function crawlWebsiteWithPlaywright({
  baseUrl,
  maxDepth,
  maxPages,
  excludePaths = [],
  businessId,
  sourceId,
  forcedUrls = [],
  chunkText,
  cleanText,
  supabase
}) {
  const visited = new Set();
  const baseDomain = new URL(baseUrl).hostname;
  let pagesCrawled = 0;
  let totalChunks = 0;
  const crawledPages = []; // For storing page metadata in DB
  const crawledPagesWithContent = []; // For agentic planner: { url, depth, text, bookingProvider }
  const bookingProviders = new Set();

  // Normalize URL: remove fragments, trailing slashes (except root)
  function normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      urlObj.hash = ''; // Remove fragments
      let pathname = urlObj.pathname;
      if (pathname !== '/' && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      urlObj.pathname = pathname;
      return urlObj.href;
    } catch (e) {
      return url;
    }
  }

  // Check if URL should be excluded
  function shouldExclude(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname + urlObj.search;
      
      return excludePaths.some(pattern => {
        if (pattern.includes('*')) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          return regex.test(path);
        }
        return path.includes(pattern);
      });
    } catch (e) {
      return false;
    }
  }

  // Initialize crawl queue with base URL, forced URLs, and sitemap URLs
  const queue = [];
  const seen = new Set();

  function enqueue(url, depth = 0, fromPriority = false) {
    if (!url) return;
    const normalized = normalizeUrl(url);
    if (seen.has(normalized)) return;
    if (shouldExclude(normalized)) return;
    seen.add(normalized);
    queue.push({ url: normalized, depth, fromPriority });
  }

  // 1) Base URL
  enqueue(baseUrl, 0, false);

  // 2) Forced URLs (if any) should be enqueued at depth 1 so they are crawled early
  if (Array.isArray(forcedUrls)) {
    for (const forced of forcedUrls) {
      try {
        const full = new URL(forced, baseUrl).toString();
        enqueue(full, 1, true);
      } catch {
        // ignore invalid forced URL
      }
    }
  }

  // 3) Sitemap URLs (optional, also depth 1)
  let sitemapUrls = [];
  try {
    sitemapUrls = await discoverUrlsFromSitemap(baseUrl, maxPages, excludePaths);
  } catch (e) {
    console.log('[SITEMAP] Failed to fetch sitemap for', baseUrl, e.message);
  }
  for (const sUrl of sitemapUrls) {
    enqueue(sUrl, 1, false);
  }

  logCrawl('Initial queue size and settings', {
    queueLength: queue.length,
    maxDepth,
    maxPages,
    baseUrl,
  });

  // Launch browser (one per crawl)
  console.log('🚀 Launching Playwright browser...');
  if (DEBUG_CRAWL) {
    logCrawl('Chromium executable path', chromium.executablePath());
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[CRAWL] Playwright launch failed (bundled chromium):', msg);

    // Railway/Nixpacks can miss shared libs for Playwright's bundled headless_shell, and Playwright
    // sometimes only surfaces a generic "Target page... has been closed" error.
    // To be robust, always attempt a fallback launch using a system-installed chromium.
    const candidates = [
      process.env.CHROMIUM_PATH,
      'chromium',
      'chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].filter(Boolean);

    for (const candidate of candidates) {
      console.warn(`[CRAWL] Fallback: retrying launch with system chromium (executablePath="${candidate}")`);
      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: candidate,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        console.log(`[CRAWL] ✅ Launched using system chromium: ${candidate}`);
        break;
      } catch (err2) {
        const msg2 = err2?.message || String(err2);
        console.error(`[CRAWL] Fallback launch failed for "${candidate}":`, msg2);
      }
    }

    if (!browser) {
      throw new Error(`PLAYWRIGHT_MISSING: ${msg}`);
    }
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  // Set timeout for page loads (increased for robustness)
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(45000);

  // Ensure screenshots directory exists
  const screenshotsDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    console.log(`📁 Created screenshots directory: ${screenshotsDir}`);
  }

  // Helper: safe navigation with retry logic
  async function safeGoto(page, url, priorityNote = '', depth = 0) {
    // Two navigation strategies:
    // 1) networkidle (ideal when it works)
    // 2) domcontentloaded (fallback when there is long-running JS)
    const strategies = [
      { mode: 'networkidle', timeout: 30000 },
      { mode: 'domcontentloaded', timeout: 45000 },
    ];

    for (let attempt = 0; attempt < strategies.length; attempt++) {
      const { mode, timeout } = strategies[attempt];
      try {
        console.log(`▶ Visiting ${url} (depth: ${depth}${priorityNote}, attempt ${attempt + 1}, waitUntil="${mode}", timeout=${timeout}ms)`);
        const response = await page.goto(url, { waitUntil: mode, timeout });
        return response; // success - return response object
      } catch (err) {
        const isTimeout =
          (PlaywrightErrors && err instanceof PlaywrightErrors.TimeoutError) ||
          err.name === 'TimeoutError';

        if (isTimeout) {
          console.warn(`⏱️ Timeout loading ${url} on attempt ${attempt + 1} (mode=${mode}).`);
          // try next strategy if available
          if (attempt === strategies.length - 1) {
            console.warn(`❌ Giving up on ${url} after all navigation strategies timed out.`);
            return null;
          }
        } else {
          console.error(`❌ Error loading ${url}:`, err.message || err);
          // for non-timeout errors, don't retry the second strategy
          return null;
        }
      }
    }

    return null;
  }

  try {
    // Main crawl loop
    while (queue.length > 0 && pagesCrawled < maxPages) {
      const { url, depth, fromPriority = false } = queue.shift();
      const normalizedUrl = normalizeUrl(url);
      
      // Skip if already visited or exceeds depth
      if (visited.has(normalizedUrl) || depth > maxDepth) {
        continue;
      }
      
      visited.add(normalizedUrl);

      try {
        // Navigate to page using safeGoto with retry logic
        const priorityNote = fromPriority ? ', priority' : '';
        const response = await safeGoto(page, normalizedUrl, priorityNote, depth);
        if (!response) {
          // Skip extraction for this URL if navigation failed
          continue;
        }

        // Check HTTP status
        if (!response.ok()) {
          const status = response.status();
          console.error(`❌ HTTP ${status} for ${normalizedUrl}`);
          continue;
        }

        // Wait for dynamic content to load (especially for SPAs)
        await page.waitForTimeout(2000); // Give JS time to render

        // Get page HTML for booking provider detection
        const html = await page.content().catch(() => '');

        // Detect booking providers from URL and HTML
        const detected = detectBookingProviders(normalizedUrl, html);
        const pageBookingProvider = detected.length > 0 ? detected[0] : null; // Track first provider for this page
        for (const id of detected) {
          if (!bookingProviders.has(id)) {
            bookingProviders.add(id);
            console.log('[BOOKING] Detected provider', id, 'on', normalizedUrl);
          }
        }

        // Take full-page screenshot after successful navigation
        const safeFileName = normalizedUrl
          .replace(/^https?:\/\//, '')
          .replace(/[^a-zA-Z0-9-_]/g, '_')
          .slice(0, 120); // avoid insane filenames

        const screenshotPath = path.join(screenshotsDir, `${safeFileName}.png`);

        try {
          await page.screenshot({
            path: screenshotPath,
            fullPage: true,
          });
          console.log(`[SCREENSHOT] Saved for ${normalizedUrl} -> ${screenshotPath}`);
        } catch (err) {
          console.warn(`[SCREENSHOT] Failed for ${normalizedUrl}:`, err.message);
        }

        // Extract title
        const title = await page.title().catch(() => '');
        const cleanTitle = cleanText(title);

        // Extract visible text from DOM
        // Remove scripts, styles, and noise elements before extracting text
        const bodyText = await page.evaluate(() => {
          // Remove non-content elements (keep nav and footer for contact info)
          const elementsToRemove = document.querySelectorAll(
            'script, style, noscript, iframe, .cookie, .cta, .social, .cookie-banner, .popup, .modal, .advertisement, .ads, [role="banner"]:not(nav):not(footer), [role="complementary"]:not(nav):not(footer)'
          );
          elementsToRemove.forEach(el => el.remove());

          // Extract text from body
          const body = document.body;
          if (!body) return '';

          // Get visible text (exclude hidden elements)
          const walker = document.createTreeWalker(
            body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: (node) => {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                
                // Skip if parent is hidden
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                  return NodeFilter.FILTER_REJECT;
                }
                
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          const textParts = [];
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            if (text) {
              textParts.push(text);
            }
          }

          return textParts.join(' ');
        });

        const cleanedText = cleanText(bodyText);
        const contentLength = cleanedText.length;

        console.log(`✔ Extracted ${contentLength} characters from ${normalizedUrl}`);

        // Store page data for agentic planner (before DB insert)
        crawledPagesWithContent.push({
          url: normalizedUrl,
          depth: depth,
          text: cleanedText,
          html: html,
          bookingProvider: pageBookingProvider
        });

        // Insert page into kb_pages
        const { data: pageRow, error: pageErr } = await supabase
          .from('kb_pages')
          .insert({
            source_id: sourceId,
            url: normalizedUrl,
            title: cleanTitle,
            status_code: response.status(),
            content_length: contentLength,
            indexed_at: new Date().toISOString()
          })
          .select()
          .single();

        if (pageErr) {
          console.error(`❌ Error inserting page ${normalizedUrl}:`, pageErr);
          continue;
        }

        crawledPages.push(pageRow);
        pagesCrawled++;

        // Chunk and insert content
        const chunks = chunkText(cleanedText, 900, 150);
        const chunkRows = chunks
          .map((text, i) => {
            const cleanChunkText = (text || '').trim();
            return {
              source_id: sourceId,
              page_id: pageRow.id,
              chunk_index: i,
              text: cleanChunkText,
              content: cleanChunkText,
              tokens: Math.ceil(cleanChunkText.length / 4),
              business_id: businessId
            };
          })
          .filter(chunk => chunk.content && chunk.content.length > 0);

        if (chunkRows.length > 0) {
          const { error: chunkErr } = await supabase.from('kb_chunks').insert(chunkRows);
          if (chunkErr) {
            console.error(`❌ Error inserting chunks for ${normalizedUrl}:`, chunkErr);
          } else {
            totalChunks += chunkRows.length;
            console.log(`  → Created ${chunkRows.length} chunks`);
          }
        }

        // Discover links for next level (if not at max depth)
        if (depth < maxDepth && pagesCrawled < maxPages) {
          let discoveredLinks = [];
          try {
            // Extract links with href and text (for priority classification)
            // IMPORTANT: Fix bare-domain hrefs like "fresha.com/..." which otherwise become incorrectly treated as internal.
            discoveredLinks = await page.$$eval('a[href]', (anchors, options) => {
              const { baseUrl, baseDomain, excludePaths } = options;
              const links = [];
              const debugBareDomain = [];

              const isBareDomainHref = (href) =>
                /^(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/|$)/i.test(String(href || '').trim());

              const normalizeHref = (href) => {
                const h = String(href || '').trim();
                if (!h) return null;
                if (h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:') || h.startsWith('#')) {
                  return null;
                }
                if (h.startsWith('http://') || h.startsWith('https://')) return h;
                if (h.startsWith('//')) return `https:${h}`;
                if (isBareDomainHref(h)) {
                  const normalized = `https://${h.replace(/^www\./i, '')}`;
                  if (debugBareDomain.length < 8) debugBareDomain.push({ href: h, normalized });
                  return normalized;
                }
                return new URL(h, baseUrl).href;
              };
              
              for (const anchor of anchors) {
                const href = anchor.getAttribute('href');
                if (!href) continue;
                
                try {
                  const fullUrl = normalizeHref(href);
                  if (!fullUrl) continue;
                  const urlObj = new URL(fullUrl);
                  
                  // Only same domain
                  if (urlObj.hostname !== baseDomain) continue;
                  
                  // Check exclude paths if provided
                  if (Array.isArray(excludePaths) && excludePaths.length > 0) {
                    const pathWithQuery = urlObj.pathname + urlObj.search;
                    const shouldExclude = excludePaths.some(pattern => {
                      if (pattern.includes('*')) {
                        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                        return regex.test(pathWithQuery);
                      }
                      return pathWithQuery.includes(pattern);
                    });
                    if (shouldExclude) continue;
                  }
                  
                  // Normalize: remove fragments, trailing slashes
                  urlObj.hash = '';
                  let pathname = urlObj.pathname;
                  if (pathname !== '/' && pathname.endsWith('/')) {
                    pathname = pathname.slice(0, -1);
                  }
                  urlObj.pathname = pathname;
                  
                  const text = (anchor.textContent || '').trim();
                  links.push({
                    href: urlObj.href,
                    text: text
                  });
                } catch (e) {
                  // Invalid URL, skip
                }
              }
              
              return { links, debugBareDomain };
            }, {
              baseUrl: normalizedUrl,
              baseDomain: baseDomain,
              excludePaths: excludePaths
            });
          } catch (linkError) {
            console.error(`❌ Error extracting links from ${normalizedUrl}:`, linkError.message);
            // Continue with next URL even if link extraction fails
            discoveredLinks = [];
          }

          // Extract internal links & log any bare-domain normalizations
          const internalLinks = Array.isArray(discoveredLinks?.links) ? discoveredLinks.links : Array.isArray(discoveredLinks) ? discoveredLinks : [];
          const debugBare = Array.isArray(discoveredLinks?.debugBareDomain) ? discoveredLinks.debugBareDomain : [];
          for (const item of debugBare) {
            console.log(`[CRAWL] Normalized bare-domain href -> ${item.normalized} (from "${item.href}")`);
          }

          // Classify links as priority and filter excluded links
          const priorityLinks = [];
          const normalLinks = [];
          
          for (const { href, text } of internalLinks) {
            // Double-check exclusion (though already filtered in eval)
            if (shouldExclude(href)) continue;
            if (visited.has(href)) continue;
            
            // Classify priority based on text and href
            const lowerText = text.toLowerCase();
            const isPriorityText = PRIORITY_LINK_TEXTS.some(key =>
              lowerText.includes(key)
            );
            const isPriorityHref = PRIORITY_HREF_PATTERNS.some(rx =>
              rx.test(href)
            );
            
            const isPriority = isPriorityText || isPriorityHref;
            
            if (isPriority) {
              priorityLinks.push(href);
            } else {
              normalLinks.push(href);
            }
          }

          console.log(`→ Discovered ${internalLinks.length} internal links (${priorityLinks.length} priority, ${normalLinks.length} normal)`);

          // Add new links to queue (priority links first, then normal links)
          // Limit queue size to prevent explosion
          let addedCount = 0;
          const maxQueueSize = 400;
          const maxLinksPerPage = 50;
          
          // Add priority links to front of queue
          for (const link of priorityLinks) {
            if (queue.length < maxQueueSize && addedCount < maxLinksPerPage && depth + 1 <= maxDepth) {
              if (!visited.has(link) && !seen.has(link)) {
                seen.add(link); // Track queued URLs to prevent duplicates
                queue.unshift({ url: link, depth: depth + 1, fromPriority: true });
                addedCount++;
                console.log(`→ PRIORITY link queued: ${link}`);
              }
            }
          }
          
          // Add normal links to back of queue
          for (const link of normalLinks) {
            if (queue.length < maxQueueSize && addedCount < maxLinksPerPage && depth + 1 <= maxDepth) {
              if (!visited.has(link) && !seen.has(link)) {
                seen.add(link); // Track queued URLs to prevent duplicates
                queue.push({ url: link, depth: depth + 1, fromPriority: false });
                addedCount++;
              }
            }
          }
        }

        // Small delay to be respectful
        await page.waitForTimeout(500);
        
      } catch (error) {
        console.error(`❌ Error crawling ${normalizedUrl}:`, error.message);
        // Continue with next URL
      }
    }

    console.log(`[CRAWL] Completed: ${pagesCrawled} pages, ${totalChunks} chunks`);
    if (bookingProviders.size > 0) {
      console.log(`[BOOKING] Detected providers: ${Array.from(bookingProviders).join(', ')}`);
    }
    
    return {
      pagesIndexed: pagesCrawled,
      chunksCreated: totalChunks,
      bookingProviders: Array.from(bookingProviders),
      pages: crawledPagesWithContent // Array of { url, depth, text, html, bookingProvider }
    };

  } finally {
    // Clean up browser resources
    await browser.close();
    console.log('🔒 Browser closed');
  }
}

