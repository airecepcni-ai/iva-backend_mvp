import * as cheerio from 'cheerio';

/**
 * Return a normalized domain token for scoring, e.g. "cutegory" from "https://www.cutegory.cz/".
 * @param {string} url
 */
function domainToken(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    return host.split('.')[0] || '';
  } catch {
    return '';
  }
}

const GENERIC_WORDS = new Set([
  'kadernictvi',
  'kadeřnictví',
  'salon',
  'salón',
  'studio',
  'studío',
  'premiove',
  'prémiové',
  'luxusni',
  'luxusní',
  'krasa',
  'krása',
  'sluzby',
  'služby',
  'vlasy',
  'vlasu',
  'vlasů',
  'barber',
]);

function normalizeNameCandidate(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim()
    .replace(/^[-–—]+\s*/, '')
    .replace(/\s*[-–—]+$/, '')
    .trim();
}

/**
 * Heuristic scoring for business/brand names.
 * Higher is better.
 * @param {string} name
 * @param {string} url
 */
export function scoreBusinessName(name, url) {
  const n = normalizeNameCandidate(name);
  if (!n) return -1000;

  let score = 0;
  const lower = n.toLowerCase();
  const token = domainToken(url);

  // Reward if matches domain token (brand-like).
  if (token && lower.includes(token)) score += 35;

  // Reward trademark markers.
  if (/[®™]/.test(n)) score += 25;

  // Prefer short-ish names over long taglines.
  if (n.length <= 25) score += 10;
  if (n.length > 60) score -= 25;

  // Penalize generic words
  const words = lower
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  for (const w of words) {
    if (GENERIC_WORDS.has(w)) score -= 12;
  }

  // Reward mixed-case brand patterns (not all lower/upper)
  const hasLower = /[a-zá-ž]/.test(n);
  const hasUpper = /[A-ZÁ-Ž]/.test(n);
  if (hasLower && hasUpper) score += 8;

  // Penalize if looks like a sentence / contains too many spaces
  const spaceCount = (n.match(/\s/g) || []).length;
  if (spaceCount >= 4) score -= 10;

  return score;
}

export function isGenericBusinessName(name, url) {
  return scoreBusinessName(name, url) < 5;
}

function extractJsonLdNames($) {
  const names = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const candidate =
          item?.name ||
          item?.publisher?.name ||
          item?.organization?.name ||
          item?.sourceOrganization?.name;
        if (candidate) names.push(String(candidate));
      }
    } catch {
      // ignore
    }
  });
  return names;
}

/**
 * Extract candidate names from HTML for brand detection.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {Array<{name: string, source: string}>}
 */
function extractNameCandidatesFromHtml(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const candidates = [];

  // JSON-LD Organization/LocalBusiness name
  for (const n of extractJsonLdNames($)) {
    candidates.push({ name: n, source: `json-ld:${pageUrl}` });
  }

  // og:site_name
  const ogSite = $('meta[property="og:site_name"]').attr('content');
  if (ogSite) candidates.push({ name: ogSite, source: `og:site_name:${pageUrl}` });

  // application-name / site name meta fallbacks
  const appName = $('meta[name="application-name"]').attr('content');
  if (appName) candidates.push({ name: appName, source: `meta:application-name:${pageUrl}` });

  // header/home link text
  const headerHomeText =
    $('header a[href="/"]').first().text() ||
    $('header a[href="./"]').first().text() ||
    $('header a').first().text();
  if (headerHomeText) candidates.push({ name: headerHomeText, source: `header:a-home:${pageUrl}` });

  // logo alt
  const logoAlt =
    $('header img[alt]').first().attr('alt') ||
    $('img[alt]').first().attr('alt');
  if (logoAlt) candidates.push({ name: logoAlt, source: `img:alt:${pageUrl}` });

  // title (last resort)
  const title = $('title').first().text();
  if (title) candidates.push({ name: title, source: `title:${pageUrl}` });

  return candidates
    .map((c) => ({ ...c, name: normalizeNameCandidate(c.name) }))
    .filter((c) => c.name);
}

/**
 * Pick a high-quality business name using prioritized sources and a heuristic score.
 *
 * @param {object} args
 * @param {Array<{url: string, html?: string}>} args.htmlPages
 * @param {string} args.url
 * @param {string|null|undefined} args.extractedName - LLM extracted name
 * @returns {{ name: string|null, source: string, score: number, topCandidates: Array<{name: string, source: string, score: number}> }}
 */
export function pickBusinessName({ htmlPages, url, extractedName }) {
  const pages = Array.isArray(htmlPages) ? htmlPages : [];
  const token = domainToken(url);

  // Prioritize homepage + kontakt pages first
  const prioritized = [...pages].sort((a, b) => {
    const aUrl = a?.url || '';
    const bUrl = b?.url || '';
    const aScore =
      (token && aUrl.includes(token) ? 2 : 0) +
      (/\/$/.test(aUrl) ? 2 : 0) +
      (/kontakt|contact/i.test(aUrl) ? 3 : 0);
    const bScore =
      (token && bUrl.includes(token) ? 2 : 0) +
      (/\/$/.test(bUrl) ? 2 : 0) +
      (/kontakt|contact/i.test(bUrl) ? 3 : 0);
    return bScore - aScore;
  });

  const candidates = [];
  if (extractedName) {
    candidates.push({ name: extractedName, source: 'llm' });
  }

  const MAX_PAGES = 6;
  for (const p of prioritized.slice(0, MAX_PAGES)) {
    if (!p?.html) continue;
    const html = p.html.length > 120000 ? p.html.slice(0, 120000) : p.html;
    candidates.push(...extractNameCandidatesFromHtml(html, p.url));
  }

  const scored = candidates
    .map((c) => ({ ...c, score: scoreBusinessName(c.name, url) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return { name: null, source: 'none', score: -1000, topCandidates: [] };

  return {
    name: best.name,
    source: best.source,
    score: best.score,
    topCandidates: scored.slice(0, 6),
  };
}





