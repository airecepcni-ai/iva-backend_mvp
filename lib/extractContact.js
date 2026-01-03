/**
 * Contact Information Extraction Utilities
 * 
 * Deterministic extraction of phone, email, and address from HTML pages.
 * Uses multiple strategies: tel:/mailto: links, regex patterns, JSON-LD, and DOM heuristics.
 * 
 * NOTE: This extracts CONTACT phone/email for business_profile.
 * This is SEPARATE from businesses.vapi_phone which is used for Twilio/Vapi call routing.
 */

/**
 * Priority keywords for identifying contact pages
 */
const CONTACT_PAGE_PATTERNS = [
  /kontakt/i,
  /contact/i,
  /o-nas/i,
  /about/i,
  /info/i,
  /provozovna/i,
];

/**
 * Email regex pattern (RFC 5322 simplified)
 */
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Czech phone regex patterns
 * Matches: +420 608 744 774, +420608744774, 608 744 774, 608744774, etc.
 */
const PHONE_PATTERNS = [
  // Full international format: +420 XXX XXX XXX
  /\+420[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}/g,
  // Without plus: 420 XXX XXX XXX
  /(?<!\d)420[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}(?!\d)/g,
  // Local format: XXX XXX XXX (9 digits)
  /(?<!\d)[0-9]{3}[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}(?!\d)/g,
];

/**
 * Address keywords for DOM extraction (Czech)
 */
const ADDRESS_KEYWORDS = [
  'adresa',
  'provozovna',
  'kde nás najdete',
  'kde nás najdeš',
  'sídlo',
  'pobočka',
  'salon',
  'studio',
];

// Keywords that often indicate a registered office / billing address (not the salon location)
const LEGAL_ADDRESS_KEYWORDS = [
  'ičo',
  'ico',
  'dič',
  'dic',
  'sídlo',
  'sidlo',
  'fakturační',
  'fakturacni',
  'společnost',
  'spolecnost',
  'zapsaná',
  'zapsana',
  'obchodní rejstřík',
  'obchodni rejstrik',
  'rejstříku',
  'rejstriku',
  's.r.o',
  'a.s',
];

function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function containsAny(haystack, needles) {
  const h = normalizeForMatch(haystack);
  return needles.some((n) => h.includes(normalizeForMatch(n)));
}

/**
 * Normalize phone number to E.164 format (+420XXXXXXXXX)
 * @param {string} phone - Raw phone string
 * @returns {string|null} Normalized phone or null if invalid
 */
export function normalizePhoneToE164(phone) {
  if (!phone || typeof phone !== 'string') return null;
  
  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  // If starts with +, keep it; otherwise add +420 for Czech
  if (cleaned.startsWith('+')) {
    // Already has country code
    if (cleaned.startsWith('+420') && cleaned.length === 13) {
      return cleaned;
    }
    // Other country codes - return as-is if reasonable length
    if (cleaned.length >= 10 && cleaned.length <= 15) {
      return cleaned;
    }
  } else if (cleaned.startsWith('420')) {
    // Has 420 without +
    cleaned = '+' + cleaned;
    if (cleaned.length === 13) {
      return cleaned;
    }
  } else if (cleaned.length === 9) {
    // Czech local number without country code
    return '+420' + cleaned;
  }
  
  // Invalid format
  return null;
}

/**
 * Check if URL is a contact/about page (higher priority for extraction)
 * @param {string} url 
 * @returns {boolean}
 */
export function isContactPage(url) {
  if (!url) return false;
  return CONTACT_PAGE_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Extract tel: links from HTML
 * @param {string} html 
 * @returns {string[]} Array of phone numbers found
 */
function extractTelLinks(html) {
  if (!html) return [];
  
  const phones = [];
  // Match tel: and href="tel:..."
  const telRegex = /(?:href\s*=\s*["']?tel:([^"'\s>]+)|tel:([^\s<"']+))/gi;
  let match;
  
  while ((match = telRegex.exec(html)) !== null) {
    const phone = match[1] || match[2];
    if (phone) {
      const normalized = normalizePhoneToE164(phone);
      if (normalized && !phones.includes(normalized)) {
        phones.push(normalized);
      }
    }
  }
  
  return phones;
}

/**
 * Extract mailto: links from HTML
 * @param {string} html 
 * @returns {string[]} Array of emails found
 */
function extractMailtoLinks(html) {
  if (!html) return [];
  
  const emails = [];
  // Match mailto: and href="mailto:..."
  const mailtoRegex = /(?:href\s*=\s*["']?mailto:([^"'\s>?]+)|mailto:([^\s<"'?]+))/gi;
  let match;
  
  while ((match = mailtoRegex.exec(html)) !== null) {
    const email = (match[1] || match[2] || '').toLowerCase().trim();
    if (email && EMAIL_REGEX.test(email) && !emails.includes(email)) {
      emails.push(email);
    }
    // Reset regex lastIndex since we're reusing EMAIL_REGEX
    EMAIL_REGEX.lastIndex = 0;
  }
  
  return emails;
}

/**
 * Extract phone numbers from text using regex
 * @param {string} text 
 * @returns {string[]} Array of normalized phone numbers
 */
function extractPhonesFromText(text) {
  if (!text) return [];
  
  const phones = new Set();
  
  for (const pattern of PHONE_PATTERNS) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      const normalized = normalizePhoneToE164(match);
      if (normalized) {
        phones.add(normalized);
      }
    }
  }
  
  return Array.from(phones);
}

/**
 * Extract emails from text using regex
 * @param {string} text 
 * @returns {string[]} Array of emails
 */
function extractEmailsFromText(text) {
  if (!text) return [];
  
  const emails = new Set();
  const matches = text.match(EMAIL_REGEX) || [];
  
  for (const match of matches) {
    const email = match.toLowerCase().trim();
    // Filter out common false positives
    if (!email.includes('example.com') && 
        !email.includes('email.com') &&
        !email.includes('youremail') &&
        !email.endsWith('.png') &&
        !email.endsWith('.jpg') &&
        !email.endsWith('.svg')) {
      emails.add(email);
    }
  }
  
  return Array.from(emails);
}

/**
 * Extract address from JSON-LD structured data
 * @param {string} html 
 * @returns {string|null} Address string or null
 */
function extractAddressFromJsonLd(html) {
  if (!html) return null;
  
  try {
    // Find all JSON-LD scripts
    const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const jsonStr = match[1].trim();
        const data = JSON.parse(jsonStr);
        
        // Handle array of objects
        const items = Array.isArray(data) ? data : [data];
        
        for (const item of items) {
          // Look for address in various schema.org formats
          const address = item.address || item.location?.address;
          
          if (address) {
            if (typeof address === 'string') {
              return address;
            }
            
            // PostalAddress format
            if (typeof address === 'object') {
              const parts = [];
              if (address.streetAddress) parts.push(address.streetAddress);
              if (address.addressLocality) parts.push(address.addressLocality);
              if (address.postalCode) parts.push(address.postalCode);
              if (address.addressCountry && address.addressCountry !== 'CZ' && address.addressCountry !== 'Česká republika') {
                parts.push(address.addressCountry);
              }
              
              if (parts.length > 0) {
                return parts.join(', ');
              }
            }
          }
        }
      } catch (parseErr) {
        // Invalid JSON, continue to next script
      }
    }
  } catch (err) {
    console.error('[CONTACT] Error parsing JSON-LD:', err.message);
  }
  
  return null;
}

/**
 * Extract address from DOM using heuristics
 * Looks for elements containing address keywords
 * @param {string} html 
 * @returns {string|null} Address string or null
 */
function extractAddressFromDom(html, pageUrl = '') {
  if (!html) return { address: null, meta: { candidates: [], picked: null, reason: 'no_html', multiLocation: false } };

  // Limit HTML size for performance (first 80KB should contain contact info)
  const limitedHtml = html.length > 80000 ? html.substring(0, 80000) : html;

  const textOnly = limitedHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedText = normalizeForMatch(textOnly);
  const hasPraha = normalizedText.includes('praha');
  const hasBrno = normalizedText.includes('brno');
  const multiLocation = hasPraha && hasBrno;

  // Simple CZ address-ish pattern
  const simpleAddressPattern = /([A-Za-z\u00C0-\u024F]+(?:\s+[A-Za-z\u00C0-\u024F]+){0,3})\s+(\d+(?:\/\d+)?)\s*,\s*(?:(\d{3}\s?\d{2})\s+)?([A-Za-z\u00C0-\u024F]+(?:\s+\d+)?)/g;

  const candidates = [];
  let m;
  const maxCandidates = 12;
  while ((m = simpleAddressPattern.exec(textOnly)) !== null) {
    const addr = m[0].trim();
    if (addr.length < 10 || addr.length > 160) continue;

    const idx = m.index;
    const contextStart = Math.max(0, idx - 140);
    const contextEnd = Math.min(textOnly.length, idx + addr.length + 140);
    const context = textOnly.slice(contextStart, contextEnd);

    let score = 0;
    const contextNorm = normalizeForMatch(context);

    // strong positives: labeled location words near address
    if (containsAny(context, ['adresa', 'provozovna', 'salon', 'pobočka', 'kde nas najdete', 'kde nás najdete'])) score += 35;
    if (contextNorm.includes('mapy') || contextNorm.includes('google') || contextNorm.includes('maps')) score += 10;
    if (contextNorm.includes('praha') || contextNorm.includes('brno')) score += 10;

    // legal/billing negatives
    if (containsAny(context, LEGAL_ADDRESS_KEYWORDS)) score -= 60;

    candidates.push({ address: addr, score, context: context.slice(0, 220) });
    if (candidates.length >= maxCandidates) break;
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates[0] || null;

  // If multi-location detected and we don't have a strong, clearly-labeled salon address, prefer summary.
  if (multiLocation) {
    const strongEnough = picked && picked.score >= 30;
    if (!strongEnough) {
      return {
        address: 'Praha a Brno',
        meta: { candidates, picked: null, reason: 'multi_location_summary', multiLocation: true, pageUrl },
      };
    }
  }

  // If the best candidate looks like a legal/billing address, reject it.
  if (picked && picked.score < 0) {
    return { address: null, meta: { candidates, picked, reason: 'rejected_low_score', multiLocation, pageUrl } };
  }

  if (picked && picked.score >= 15) {
    return { address: picked.address, meta: { candidates, picked, reason: 'picked_scored_candidate', multiLocation, pageUrl } };
  }

  return { address: null, meta: { candidates, picked, reason: 'no_confident_candidate', multiLocation, pageUrl } };
}

/**
 * Extract phone and email from JSON-LD structured data
 * @param {string} html 
 * @returns {{ phone: string|null, email: string|null }}
 */
function extractContactFromJsonLd(html) {
  if (!html) return { phone: null, email: null };
  
  let phone = null;
  let email = null;
  
  try {
    const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1].trim());
        const items = Array.isArray(data) ? data : [data];
        
        for (const item of items) {
          // Phone
          if (!phone && item.telephone) {
            phone = normalizePhoneToE164(item.telephone);
          }
          
          // Email
          if (!email && item.email) {
            const emailCandidate = item.email.toLowerCase().trim();
            if (EMAIL_REGEX.test(emailCandidate)) {
              email = emailCandidate;
            }
            EMAIL_REGEX.lastIndex = 0;
          }
        }
      } catch (parseErr) {
        // Invalid JSON, continue
      }
    }
  } catch (err) {
    // Ignore errors
  }
  
  return { phone, email };
}

/**
 * Extract all contact information from a single HTML page
 * 
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL (used for priority detection)
 * @returns {{
 *   phone: string|null,
 *   email: string|null,
 *   address: string|null,
 *   sources: { phone?: string, email?: string, address?: string }
 * }}
 */
export function extractContactFromHtml(html, url) {
  const result = {
    phone: null,
    email: null,
    address: null,
    sources: {},
  };
  
  if (!html) return result;
  
  // Strip scripts and styles for text extraction
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  
  // 1. Try JSON-LD first (most reliable)
  const jsonLdContact = extractContactFromJsonLd(html);
  const jsonLdAddress = extractAddressFromJsonLd(html);
  
  if (jsonLdContact.phone) {
    result.phone = jsonLdContact.phone;
    result.sources.phone = 'json-ld';
  }
  if (jsonLdContact.email) {
    result.email = jsonLdContact.email;
    result.sources.email = 'json-ld';
  }
  if (jsonLdAddress) {
    result.address = jsonLdAddress;
    result.sources.address = 'json-ld';
  }
  
  // 2. Try tel: and mailto: links
  if (!result.phone) {
    const telPhones = extractTelLinks(html);
    if (telPhones.length > 0) {
      result.phone = telPhones[0];
      result.sources.phone = 'tel-link';
    }
  }
  
  if (!result.email) {
    const mailtoEmails = extractMailtoLinks(html);
    if (mailtoEmails.length > 0) {
      result.email = mailtoEmails[0];
      result.sources.email = 'mailto-link';
    }
  }
  
  // 3. Try regex on text content
  if (!result.phone) {
    const textPhones = extractPhonesFromText(textContent);
    if (textPhones.length > 0) {
      result.phone = textPhones[0];
      result.sources.phone = 'text-regex';
    }
  }
  
  if (!result.email) {
    const textEmails = extractEmailsFromText(textContent);
    if (textEmails.length > 0) {
      result.email = textEmails[0];
      result.sources.email = 'text-regex';
    }
  }
  
  // 4. Try DOM heuristics for address
  if (!result.address) {
    const dom = extractAddressFromDom(html, url);
    if (dom?.meta?.candidates?.length) {
      console.log('[CONTACT] Address candidates:', {
        url,
        multiLocation: dom.meta.multiLocation,
        reason: dom.meta.reason,
        top: dom.meta.candidates.slice(0, 5).map((c) => ({ address: c.address, score: c.score })),
      });
    }
    if (dom?.address) {
      result.address = dom.address;
      result.sources.address = 'dom-heuristic';
      console.log(`[CONTACT] Picked address: ${result.address} reason=${dom?.meta?.reason || 'unknown'} url=${url}`);
    } else if (dom?.meta?.multiLocation) {
      console.log(`[CONTACT] Multi-location detected; using address summary "Praha a Brno" url=${url}`);
    }
  }
  
  return result;
}

/**
 * Extract contact information from multiple crawled pages
 * Prioritizes contact/about pages and merges results
 * 
 * @param {Array<{url: string, html: string}>} pages - Crawled pages with HTML
 * @returns {{
 *   phone: string|null,
 *   email: string|null,
 *   address: string|null,
 *   sources: { phone?: string, email?: string, address?: string }
 * }}
 */
export function extractContactFromPages(pages) {
  const result = {
    phone: null,
    email: null,
    address: null,
    sources: {},
  };
  
  if (!pages || !Array.isArray(pages) || pages.length === 0) {
    return result;
  }
  
  // Sort pages: contact pages first
  const sortedPages = [...pages].sort((a, b) => {
    const aIsContact = isContactPage(a.url);
    const bIsContact = isContactPage(b.url);
    if (aIsContact && !bIsContact) return -1;
    if (!aIsContact && bIsContact) return 1;
    return 0;
  });
  
  console.log(`[CONTACT] Processing ${pages.length} pages for contact extraction`);
  
  // Track which pages yielded results
  const foundFrom = {};
  let pagesProcessed = 0;
  
  for (const page of sortedPages) {
    if (!page.html || !page.url) continue;
    
    // Limit HTML size to prevent performance issues (keep first 100KB)
    const MAX_HTML_SIZE = 100000;
    const html = page.html.length > MAX_HTML_SIZE 
      ? page.html.substring(0, MAX_HTML_SIZE) 
      : page.html;
    
    pagesProcessed++;
    const isContact = isContactPage(page.url);
    console.log(`[CONTACT] Processing page ${pagesProcessed}/${sortedPages.length}: ${page.url} (${html.length} chars${isContact ? ', CONTACT PAGE' : ''})`);
    
    let pageContact;
    try {
      pageContact = extractContactFromHtml(html, page.url);
    } catch (err) {
      console.error(`[CONTACT] Error extracting from ${page.url}:`, err.message);
      continue;
    }
    
    // Phone: prefer contact page result, otherwise first found
    if (pageContact.phone && !result.phone) {
      result.phone = pageContact.phone;
      result.sources.phone = `${pageContact.sources.phone} from ${page.url}`;
      foundFrom.phone = page.url;
      console.log(`[CONTACT] phone found: ${result.phone} (${result.sources.phone})`);
    } else if (pageContact.phone && isContact && !foundFrom.phone?.includes('kontakt')) {
      // Contact page phone takes precedence
      result.phone = pageContact.phone;
      result.sources.phone = `${pageContact.sources.phone} from ${page.url}`;
      foundFrom.phone = page.url;
      console.log(`[CONTACT] phone updated from contact page: ${result.phone} (${result.sources.phone})`);
    }
    
    // Email: prefer contact page result, otherwise first found
    if (pageContact.email && !result.email) {
      result.email = pageContact.email;
      result.sources.email = `${pageContact.sources.email} from ${page.url}`;
      foundFrom.email = page.url;
      console.log(`[CONTACT] email found: ${result.email} (${result.sources.email})`);
    } else if (pageContact.email && isContact && !foundFrom.email?.includes('kontakt')) {
      result.email = pageContact.email;
      result.sources.email = `${pageContact.sources.email} from ${page.url}`;
      foundFrom.email = page.url;
      console.log(`[CONTACT] email updated from contact page: ${result.email} (${result.sources.email})`);
    }
    
    // Address: prefer longer/more specific, especially from contact pages
    if (pageContact.address) {
      const newAddressLen = pageContact.address.length;
      const currentAddressLen = result.address?.length || 0;
      
      // Take new address if:
      // 1. We don't have one yet
      // 2. New one is from contact page and current isn't
      // 3. New one is significantly longer (more specific)
      const shouldUpdate = !result.address ||
        (isContact && !foundFrom.address?.includes('kontakt')) ||
        (newAddressLen > currentAddressLen + 10);
      
      if (shouldUpdate) {
        result.address = pageContact.address;
        result.sources.address = `${pageContact.sources.address} from ${page.url}`;
        foundFrom.address = page.url;
        console.log(`[CONTACT] address found: ${result.address} (${result.sources.address})`);
      }
    }
    
    // Early exit if we have all fields
    if (result.phone && result.email && result.address) {
      break;
    }
  }
  
  return result;
}

/**
 * Merge deterministic contact extraction with LLM extraction
 * Deterministic values take precedence when available
 * 
 * @param {object} deterministicContact - From extractContactFromPages
 * @param {object} llmExtracted - From OpenAI extraction
 * @returns {object} Merged profile data
 */
export function mergeContactData(deterministicContact, llmExtracted) {
  const merged = {
    name: llmExtracted?.name || null,
    address: deterministicContact?.address || llmExtracted?.address || null,
    phone: deterministicContact?.phone || llmExtracted?.phone || null,
    email: deterministicContact?.email || llmExtracted?.email || null,
  };
  
  // Log merge decisions
  if (deterministicContact?.phone && llmExtracted?.phone && deterministicContact.phone !== llmExtracted.phone) {
    console.log(`[CONTACT] Using deterministic phone (${deterministicContact.phone}) over LLM (${llmExtracted.phone})`);
  }
  if (deterministicContact?.email && llmExtracted?.email && deterministicContact.email !== llmExtracted.email) {
    console.log(`[CONTACT] Using deterministic email (${deterministicContact.email}) over LLM (${llmExtracted.email})`);
  }
  if (deterministicContact?.address && llmExtracted?.address && deterministicContact.address !== llmExtracted.address) {
    console.log(`[CONTACT] Using deterministic address (${deterministicContact.address}) over LLM (${llmExtracted.address})`);
  }
  
  return merged;
}

export default {
  extractContactFromHtml,
  extractContactFromPages,
  mergeContactData,
  normalizePhoneToE164,
  isContactPage,
};



