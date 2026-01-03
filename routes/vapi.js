import express from 'express';
import { handleChatMessage, getIvaSettingsForTenant } from '../lib/chatHandler.js';
import { createBooking } from '../lib/bookingService.js';
import { parseRelativeDate } from '../lib/dateUtils.js';
import { supabase } from '../lib/supabaseClient.js';
import { cancelCalendarEvent, rescheduleCalendarEvent, isSlotAvailable } from '../lib/googleCalendar.js';
import { DateTime } from 'luxon';
import { resolveBusinessByCalledNumber, extractCalledNumberDetailed, normalizeE164Like } from '../lib/tenantResolver.js';

/**
 * Resolve Czech relative dates like "zítra", "pozítří", "dnes" to ISO YYYY-MM-DD.
 * Also handles ISO dates, Czech DD.MM.YYYY, DD.MM., Czech month names, and numeric dates with spaces.
 * Uses Europe/Prague timezone context for "today" calculations.
 * 
 * @param {string} rawDate - Raw date string from user (e.g. "zítra", "15.12.2025", "8. 12.", "26. prosince")
 * @param {Date} now - Reference date (defaults to current time)
 * @returns {string|null} - ISO date string "YYYY-MM-DD" or null if parsing fails
 */
function resolveCzechDate(rawDate, now = new Date()) {
  if (!rawDate) return null;

  // Check if user explicitly provided a year
  const hadExplicitYear = /\b(19|20)\d{2}\b/.test(rawDate);

  // Step 1: Normalize input
  // Trim and collapse multiple spaces into single space
  let normalized = rawDate.trim().replace(/\s+/g, ' ');
  
  // Remove spaces directly next to dots ONLY in numeric contexts (digit-dot-digit)
  // Pattern: digit-space-dot-digit becomes digit-dot-digit
  // But preserve spaces before letters (month names)
  normalized = normalized.replace(/(\d)\s+\.(\d)/g, '$1.$2');
  
  // Convert to lowercase for matching
  normalized = normalized.toLowerCase();

  // Normalize accents / simple variants for relative dates
  const n = normalized
    .replace('dneska', 'dnes')
    .replace('zitra', 'zítra')
    .replace('pozitri', 'pozítří');

  // Get current date in Europe/Prague timezone
  const today = DateTime.fromJSDate(now).setZone('Europe/Prague').startOf('day');

  // Helper function to resolve date with year logic (current year, or next year if past)
  const resolveDateWithYear = (day, month, year = null) => {
    let candidateYear = year || today.year;
    let candidate = DateTime.fromObject({
      year: candidateYear,
      month,
      day,
    }, { zone: 'Europe/Prague' });
    
    // If candidate date is invalid (e.g., Feb 30), return null
    if (!candidate.isValid || candidate.day !== day || candidate.month !== month) {
      return null;
    }
    
    const originalDate = candidate.toISODate();
    
    // If no explicit year was provided and candidate is in the past, use next year
    if (year === null && candidate < today) {
      candidateYear = today.year + 1;
      candidate = DateTime.fromObject({
        year: candidateYear,
        month,
        day,
      }, { zone: 'Europe/Prague' });
      
      // Safety check: if still invalid or somehow still in past, return null
      if (!candidate.isValid || candidate.day !== day || candidate.month !== month || candidate.year < today.year) {
        return null;
      }
      
      console.log('[resolveCzechDate] final date check', {
        rawDate,
        hadExplicitYear,
        originalDate,
        finalDate: candidate.toISODate(),
      });
    }
    
    // Final safety check: never return dates with year < current year
    if (candidate.year < today.year) {
      return null;
    }
    
    return candidate.toISODate();
  };

  // Relative dates (check these first)
  if (n === 'dnes') {
    return today.toISODate();
  }

  if (n === 'zítra') {
    return today.plus({ days: 1 }).toISODate();
  }

  if (n === 'pozítří') {
    return today.plus({ days: 2 }).toISODate();
  }

  // Already ISO-like YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(n)) {
    // If no explicit year was detected in raw input, check if date is in past
    if (!hadExplicitYear) {
      const dt = DateTime.fromISO(n).setZone('Europe/Prague').startOf('day');
      if (dt.isValid && dt < today) {
        // Move forward one year
        const nextYear = dt.plus({ years: 1 });
        console.log('[resolveCzechDate] final date check', {
          rawDate,
          hadExplicitYear,
          originalDate: n,
          finalDate: nextYear.toISODate(),
        });
        return nextYear.toISODate();
      }
    }
    return n;
  }

  // Czech month names mapping (nominative and genitive forms, with and without accents)
  // Note: Luxon uses 1-12 for months, not 0-11
  const CZECH_MONTHS = {
    'leden': 1, 'ledna': 1,
    'únor': 2, 'unor': 2, 'února': 2, 'unora': 2,
    'březen': 3, 'brezen': 3, 'března': 3, 'brezna': 3,
    'duben': 4, 'dubna': 4,
    'květen': 5, 'kveten': 5, 'května': 5, 'kvetna': 5,
    'červen': 6, 'cerven': 6, 'června': 6, 'cervna': 6,
    'červenec': 7, 'cervenec': 7, 'července': 7, 'cervence': 7,
    'srpen': 8, 'srpna': 8,
    'září': 9, 'zari': 9,
    'říjen': 10, 'rijen': 10, 'října': 10, 'rijna': 10,
    'listopad': 11, 'listopadu': 11,
    'prosinec': 12, 'prosince': 12,
  };

  // Normalize text by removing diacritics for approximate month matching
  const normalizedForApprox = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // Remove diacritics

  // Support for "začátkem / v polovině / koncem měsíce"
  // Pattern: začátkem/zacatkem/v polovině/v polovine/v půlce/v pulce/koncem + month name
  const approxMatch = normalizedForApprox.match(
    /^(zacatkem|v polovine|v pulce|koncem)\s+([a-z]+)/
  );

  if (approxMatch) {
    const approxWord = approxMatch[1]; // zacatkem / v polovine / koncem
    const monthWordNoAccents = approxMatch[2];  // leden / prosince / zari (without accents)
    
    // Try to find month by matching normalized version against CZECH_MONTHS keys (both with and without accents)
    let month = undefined;
    for (const [key, value] of Object.entries(CZECH_MONTHS)) {
      const keyNoAccents = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (keyNoAccents === monthWordNoAccents || key === monthWordNoAccents) {
        month = value;
        break;
      }
    }
    
    // Also try extracting from original normalized string (with accents)
    if (month === undefined) {
      const monthMatchFromOriginal = normalized.match(/\s+([a-záčďéěíňóřšťúůýž]+)$/);
      if (monthMatchFromOriginal) {
        const monthWordOriginal = monthMatchFromOriginal[1];
        month = CZECH_MONTHS[monthWordOriginal];
      }
    }
    
    if (month !== undefined) {
      let day = 15; // Default to mid-month

      if (approxWord === 'zacatkem') {
        day = 5; // Beginning of month
      } else if (approxWord === 'koncem') {
        day = 25; // End of month
      } else {
        // v polovině / v půlce → 15
        day = 15;
      }

      // Use the helper function which handles year logic
      // For "začátkem/koncem" expressions, we never have explicit year, so pass null
      const result = resolveDateWithYear(day, month, null);
      
      if (result) {
        console.log('[resolveCzechDate] approx month phrase', {
          rawDate,
          approxWord,
          monthWord: monthWordNoAccents,
          resolvedDate: result,
        });
        return result;
      }
    }
  }

  // Czech month name format: "26. prosince", "26 prosince", "26. prosince 2025", "26 prosince 2025"
  // Pattern: day, optional dot, space(s), month name, optional space(s) and year
  const monthNameMatch = n.match(/^(\d{1,2})\s*\.?\s+([a-zá-ž]+)(?:\s+(\d{4}))?\s*$/);
  if (monthNameMatch) {
    const day = parseInt(monthNameMatch[1], 10);
    const monthName = monthNameMatch[2];
    const yearStr = monthNameMatch[3];
    
    const month = CZECH_MONTHS[monthName];
    if (month) {
      const year = yearStr ? parseInt(yearStr, 10) : null;
      return resolveDateWithYear(day, month, year);
    }
  }

  // Numeric format with optional year: "26.12.2025", "26.12.", "26. 12.", "26 12 2025"
  // Pattern: day, separator (. or space), month, optional separator, optional year
  const numericMatch = n.match(/^(\d{1,2})\s*[.\-/\s]+\s*(\d{1,2})\s*[.\-/\s]*\s*(\d{4})?\s*$/);
  if (numericMatch) {
    const day = parseInt(numericMatch[1], 10);
    const month = parseInt(numericMatch[2], 10);
    const yearStr = numericMatch[3];
    
    if (yearStr) {
      // Explicit year provided
      let year = parseInt(yearStr, 10);
      if (year < 100) year += 2000;
      return resolveDateWithYear(day, month, year);
    } else {
      // No year - use current year logic
      return resolveDateWithYear(day, month, null);
    }
  }

  // Czech DD.MM.YYYY or DD.MM.YY (with explicit year) - legacy format without spaces
  const dmY = n.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (dmY) {
    const day = parseInt(dmY[1], 10);
    const month = parseInt(dmY[2], 10);
    let year = parseInt(dmY[3], 10);
    if (year < 100) year += 2000;
    
    return resolveDateWithYear(day, month, year);
  }

  // Czech DD.MM. or DD.MM (day + month, no year) - legacy format without spaces
  const dm = n.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const month = parseInt(dm[2], 10);
    return resolveDateWithYear(day, month, null);
  }

  // Fallback: try European-style "24.11.2025" (already handled above, but keep as fallback)
  const dotMatch = n.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const [_, d, m, y] = dotMatch;
    const dt = DateTime.fromObject({
      day: Number(d),
      month: Number(m),
      year: Number(y),
    }, { zone: 'Europe/Prague' });
    if (dt.isValid) {
      const result = dt.toISODate();
      // Final check: if no explicit year and date is in past, move forward
      if (!hadExplicitYear && dt < today) {
        const nextYear = dt.plus({ years: 1 });
        console.log('[resolveCzechDate] final date check', {
          rawDate,
          hadExplicitYear,
          originalDate: result,
          finalDate: nextYear.toISODate(),
        });
        return nextYear.toISODate();
      }
      return result;
    }
  }

  // Fallback: if Date.parse can handle it as an absolute date, use it
  const parsed = Date.parse(rawDate);
  if (!Number.isNaN(parsed)) {
    const dt = DateTime.fromJSDate(new Date(parsed)).setZone('Europe/Prague');
    if (dt.isValid) {
      const result = dt.toISODate();
      // Final check: if no explicit year and date is in past, move forward
      if (!hadExplicitYear && dt < today) {
        const nextYear = dt.plus({ years: 1 });
        console.log('[resolveCzechDate] final date check', {
          rawDate,
          hadExplicitYear,
          originalDate: result,
          finalDate: nextYear.toISODate(),
        });
        return nextYear.toISODate();
      }
      return result;
    }
  }

  return null;
}

const router = express.Router();

// In-memory tenant cache (per running process). Keyed by call/session id.
// This avoids repeated called-number DB lookups across webhook + tool calls.
const __tenantBySessionId = new Map();

function isProdEnv() {
  return process.env.NODE_ENV === 'production';
}

function getSessionIdFromCall(call) {
  if (!call || typeof call !== 'object') return null;
  return call.id || call.callId || call.call_id || null;
}

function getSessionIdFromAny(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const call = payload.call || payload.message?.call || null;
  return (
    getSessionIdFromCall(call) ||
    payload.callId ||
    payload.call_id ||
    payload.sessionId ||
    payload.session_id ||
    null
  );
}

function extractTenantIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Common tool shapes: { businessId }, { tenantId }, { metadata: { tenantId } }, { call: { metadata: ... } }
  const body = payload;
  const call = body.call || body.message?.call || null;
  const meta =
    body.metadata ||
    body.meta ||
    body.variables ||
    body.vars ||
    call?.metadata ||
    body.message?.conversation?.metadata ||
    body.conversation?.metadata ||
    null;

  return (
    body.tenantId ||
    body.tenant_id ||
    body.businessId ||
    body.business_id ||
    meta?.tenantId ||
    meta?.tenant_id ||
    meta?.businessId ||
    meta?.business_id ||
    call?.metadata?.tenantId ||
    call?.metadata?.businessId ||
    null
  );
}

async function resolveTenantForVapi(payload, { allowDbLookup }) {
  const isProd = isProdEnv();
  const sessionId = getSessionIdFromAny(payload);

  // 1) Prefer explicit tenantId/businessId from payload metadata/vars.
  const explicit = extractTenantIdFromPayload(payload);
  if (explicit && typeof explicit === 'string' && explicit.trim().length > 0) {
    if (sessionId) __tenantBySessionId.set(sessionId, explicit.trim());
    if (!isProd) console.log('[vapi] tenant source: metadata');
    return { tenantId: explicit.trim(), source: 'metadata' };
  }

  // 2) Next, in-memory cache based on sessionId.
  if (sessionId && __tenantBySessionId.has(sessionId)) {
    const cached = __tenantBySessionId.get(sessionId);
    if (typeof cached === 'string' && cached.trim().length > 0) {
      if (!isProd) console.log('[vapi] tenant source: metadata');
      return { tenantId: cached, source: 'metadata' };
    }
  }

  // 3) Optional DB lookup by called number (dev, or first webhook when allowed).
  if (allowDbLookup) {
    const resolved = await resolveBusinessByCalledNumber(payload);
    if (resolved?.ok && resolved.businessId) {
      if (!isProd) console.log('[vapi] tenant source: called-number');
      if (!isProd && resolved?.fallbackUsed === 'phone') {
        console.warn('[vapi] Dev fallback used: businesses.phone (deprecated). Please migrate to businesses.vapi_phone');
      }
      if (sessionId) __tenantBySessionId.set(sessionId, resolved.businessId);
      return { tenantId: resolved.businessId, source: 'called-number', resolved };
    }
    return { tenantId: null, source: 'called-number', resolved };
  }

  return { tenantId: null, source: 'none' };
}

async function isBusinessSubscribed(businessId) {
  if (!businessId || typeof businessId !== 'string') return false;
  const { data, error } = await supabase
    .from('businesses')
    .select('id, is_subscribed')
    .eq('id', businessId)
    .maybeSingle();
  if (error) return false;
  return data?.is_subscribed === true;
}

/**
 * Vapi webhook endpoint - Server URL format
 * POST /vapi/webhook
 * 
 * Handles Vapi Server URL events according to:
 * https://docs.vapi.ai/server-url/events
 * 
 * Expected body format:
 * {
 *   "message": {
 *     "type": "assistant-request" | "function-call" | "status-update" | etc.,
 *     "call": { ... },
 *     "assistant": { ... },
 *     "customer": { ... },
 *     "artifact": {
 *       "messages": [ ... ],
 *       "transcript": "...",
 *       ...
 *     }
 *   }
 * }
 */
router.post('/webhook', async (req, res) => {
  try {
    // Dev-only payload introspection to harden "To" extraction for real provider payloads.
    if (process.env.NODE_ENV !== 'production') {
      const body = req.body ?? {};
      const topKeys = body && typeof body === 'object' ? Object.keys(body) : [];
      const msg = body?.message ?? null;
      const call = msg?.call ?? body?.call ?? null;
      const customer = msg?.customer ?? body?.customer ?? null;

      const redact = (v) => {
        if (typeof v !== 'string') return v;
        const s = v.trim();
        if (s.length <= 6) return s;
        return `${s.slice(0, 4)}…${s.slice(-2)}`;
      };

      const extracted = extractCalledNumberDetailed(body);
      const normalizedTo = extracted?.to ? normalizeE164Like(extracted.to) : null;

      console.log('[vapi][dev] webhook body keys:', topKeys);
      console.log('[vapi][dev] to candidates:', {
        'payload.to': redact(body?.to),
        'payload.To': redact(body?.To),
        'message.call.to': redact(call?.to),
        'message.call.toNumber': redact(call?.toNumber ?? call?.to_number),
        'message.call.destination': redact(call?.destination ?? call?.destinationNumber ?? call?.destination_number),
        'message.call.phoneNumber': redact(call?.phoneNumber ?? call?.phone_number),
        'message.customer.number': redact(customer?.number ?? customer?.phoneNumber ?? customer?.phone_number),
        extracted: {
          to: redact(extracted?.to),
          sourcePath: extracted?.sourcePath,
          normalized: redact(normalizedTo),
        },
      });
    }

    const { message } = req.body ?? {};

    if (!message || typeof message.type !== 'string') {
      console.warn('[VAPI] Invalid payload structure:', req.body);
      return res.status(400).json({ error: 'Invalid Vapi payload' });
    }

    console.log('[VAPI] Incoming message type:', message.type);

    switch (message.type) {
      case 'assistant-request':
        return await handleAssistantRequest(message, res, req.body);
      
      case 'conversation-update':
        // Handle actual conversation messages here
        return await handleConversationUpdate(message, res, req.body);
      
      case 'function-call':
      case 'status-update':
      case 'end-of-call-report':
        // Log but don't handle for now
        console.log('[VAPI] Unhandled event type:', message.type);
        return res.status(200).json({ ok: true });
      
      default:
        console.log('[VAPI] Unknown event type:', message.type);
        return res.status(200).json({ ok: true });
    }
  } catch (err) {
    console.error('[VAPI] Error in /vapi/webhook:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Omlouvám se, něco se pokazilo. Prosím, obraťte se přímo na salon.',
    });
  }
});

/**
 * Handle assistant-request events from Vapi
 * This event occurs at the START of a call - Vapi is asking which assistant to use
 * We respond with the assistantId so Vapi knows which assistant configuration to load
 */
async function handleAssistantRequest(message, res, rawPayload) {
  const call = message.call || {};
  const callId = call.id || call.callId || 'unknown';

  console.log('[VAPI] assistant-request for call', callId);

  // Resolve assistant ID from env or use default dev assistant
  const assistantId = process.env.VAPI_ASSISTANT_ID || 'ec14b975-4030-4061-b534-c4018784659d';

  // Resolve and cache tenant early (once per conversation) when possible.
  // In production we rely on called-number mapping; in dev we may fall back later.
  try {
    const sessionId = getSessionIdFromCall(call);
    if (sessionId && !__tenantBySessionId.has(sessionId)) {
      const { tenantId, resolved } = await resolveTenantForVapi(rawPayload ?? message ?? call, {
        // Only do DB lookup here if no explicit metadata was provided.
        allowDbLookup: true,
      });
      if (tenantId) {
        __tenantBySessionId.set(sessionId, tenantId);
      }
      // If number is unmapped in prod, we still return assistantId; routing will be blocked later.
      if (isProdEnv() && resolved && !resolved.ok) {
        console.warn('[VAPI] assistant-request: no phone mapping (prod)', { to: resolved.to });
      }
    }
  } catch (e) {
    console.warn('[VAPI] assistant-request tenant resolve failed:', e?.message ?? String(e));
  }

  console.log('[VAPI] Returning assistantId:', assistantId);

  // Respond with assistantId so Vapi knows which assistant to use
  return res.status(200).json({
    assistantId: assistantId,
  });
}

/**
 * Handle conversation-update events from Vapi
 * This event contains actual user messages and conversation state
 * Extracts the latest user message and calls IVA runtime
 */
async function handleConversationUpdate(message, res, rawPayload) {
  const call = message.call || {};
  const artifact = message.artifact || {};
  const customer = message.customer || {};

  // 1) Determine tenantId (businessId)
  const isProd = isProdEnv();
  const payloadForTenant = rawPayload ?? message ?? call;

  // Prefer metadata/cache; only do called-number DB lookup when missing.
  const tenantResult = await resolveTenantForVapi(payloadForTenant, {
    allowDbLookup: true,
  });

  let tenantId = tenantResult.tenantId || null;
  const resolved = tenantResult.resolved || null;

  // Production safety: require called-number mapping (or explicit metadata) – no silent fallback.
  if (isProd && !tenantId) {
    console.warn('[VAPI] Unknown called number (prod - no tenant):', resolved?.to ?? null);
    return res.status(200).json({
      response: {
        type: 'assistant-response',
        response: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Omlouvám se, toto telefonní číslo neznám. Prosím zkontrolujte číslo salonu.',
          }],
        },
      },
    });
  }

  // Dev-only fallback: allow DEFAULT_BUSINESS_ID when there is no phone mapping and no metadata.
  if (!isProd && !tenantId) {
    tenantId = process.env.DEFAULT_BUSINESS_ID || null;
    if (tenantId) {
      console.log('[vapi] Dev fallback tenant used (no phone mapping found)');
    }
  }

  if (!tenantId) {
    console.error('[VAPI] No tenant resolved');
    return res.status(200).json({
      response: {
        type: 'assistant-response',
        response: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Omlouvám se, toto telefonní číslo neznám. Prosím zkontrolujte číslo salonu.',
          }],
        },
      },
    });
  }

  // If we did a called-number lookup and it explicitly says not subscribed, block early.
  if (resolved && !resolved.ok && resolved.error === 'not_subscribed') {
    console.warn('[VAPI] Business not subscribed for called number:', {
      to: resolved.to,
      businessId: resolved.businessId,
    });
    return res.status(200).json({
      response: {
        type: 'assistant-response',
        response: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Omlouvám se, služba IVA není pro tento salon aktivní. Prosím, zavolejte přímo do salonu.',
          }],
        },
      },
    });
  }

  // Ensure subscription gating even when we used fallback tenantId.
  // (If resolved.ok then we already know it's subscribed.)
  if (!resolved?.ok || !resolved?.isSubscribed) {
    const ok = await isBusinessSubscribed(tenantId);
    if (!ok) {
      console.warn('[VAPI] Tenant is not subscribed (fallback or missing mapping). Blocking.', {
        tenantId,
      });
      return res.status(200).json({
        response: {
          type: 'assistant-response',
          response: {
            role: 'assistant',
            content: [{
              type: 'text',
              text: 'Omlouvám se, služba IVA není pro tento salon aktivní. Prosím, zavolejte přímo do salonu.',
            }],
          },
        },
      });
    }
  }

  // 2) Extract user text using robust logic
  // Try multiple sources: conversation.messages, artifact.messages, transcript
  const conversation = message.conversation ?? message.data?.conversation ?? null;
  const conversationMessages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const artifactMessages = Array.isArray(artifact?.messages) ? artifact.messages : [];
  
  // Combine both sources, prefer conversation messages
  const allMessages = [...conversationMessages, ...artifactMessages];
  
  // Get the last message (most recent)
  const lastMessage = allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;

  let userText = null;

  // Primary check: lastMessage.message field (this is what Vapi actually sends)
  if (
    lastMessage &&
    (lastMessage.role === 'user' || lastMessage.role === 'customer') &&
    typeof lastMessage.message === 'string' &&
    lastMessage.message.trim().length > 0
  ) {
    userText = lastMessage.message.trim();
  }
  // Secondary check: lastMessage.content array
  else if (lastMessage && lastMessage.content && Array.isArray(lastMessage.content)) {
    const textContent = lastMessage.content.find((c) => c.type === 'text' || c.type === 'transcript');
    if (textContent && (textContent.text || textContent.transcript)) {
      userText = (textContent.text || textContent.transcript).trim();
    }
  }
  // Tertiary check: lastMessage.content as string
  else if (lastMessage && typeof lastMessage.content === 'string' && lastMessage.content.trim().length > 0) {
    userText = lastMessage.content.trim();
  }
  // Fourth check: lastMessage.text
  else if (lastMessage && typeof lastMessage.text === 'string' && lastMessage.text.trim().length > 0) {
    userText = lastMessage.text.trim();
  }
  // Fifth check: lastMessage.transcript
  else if (lastMessage && typeof lastMessage.transcript === 'string' && lastMessage.transcript.trim().length > 0) {
    userText = lastMessage.transcript.trim();
  }
  // Fallback: message.transcript (top-level)
  else if (typeof message.transcript === 'string' && message.transcript.trim().length > 0) {
    userText = message.transcript.trim();
  }
  // Fallback: artifact.transcript
  else if (typeof artifact.transcript === 'string' && artifact.transcript.trim().length > 0) {
    // Extract last sentence or paragraph from transcript
    const transcriptLines = artifact.transcript.split('\n').filter((l) => l.trim());
    if (transcriptLines.length > 0) {
      userText = transcriptLines[transcriptLines.length - 1].trim();
    }
  }
  // Fallback: nested transcript.text
  else if (
    message.transcript?.text &&
    typeof message.transcript.text === 'string' &&
    message.transcript.text.trim().length > 0
  ) {
    userText = message.transcript.text.trim();
  }

  // Only log warning if we truly have no user text after all checks
  if (!userText) {
    console.warn('[VAPI] No user text found in conversation-update', {
      messagesCount: allMessages.length,
      conversationMessagesCount: conversationMessages.length,
      artifactMessagesCount: artifactMessages.length,
      lastMessage: lastMessage,
      hasTopLevelTranscript: !!message.transcript,
      hasArtifactTranscript: !!artifact.transcript,
    });
    
    return res.status(200).json({
      response: {
        type: 'assistant-response',
        response: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Promiňte, neslyšel jsem vás. Můžete to prosím zopakovat?',
          }],
        },
      },
    });
  }

  console.log('[VAPI] User text from phone:', userText);

  // 3) Get session ID from call (for conversation history)
  const sessionId = call.id || call.callId || `vapi-${call.phoneNumber || 'unknown'}`;
  // Cache tenant for subsequent tool calls/webhooks.
  const stableSessionId = getSessionIdFromCall(call);
  if (stableSessionId) __tenantBySessionId.set(stableSessionId, tenantId);

  // 4) Call IVA runtime (reusing existing chat handler - same as dashboard)
  const ivaResult = await handleChatMessage({
    tenantId,
    message: userText,
    sessionId,
    source: 'vapi',
  });

  const replyText = ivaResult.message || 'Rozumím. Jak vám mohu ještě pomoci s rezervací?';

  console.log('[VAPI] IVA reply:', replyText.substring(0, 200));
  if (ivaResult.booking_sent) {
    console.log('[VAPI] Booking created:', {
      bookingId: ivaResult.booking_id,
      calendarEventId: ivaResult.calendar_event_id,
    });
  }

  // 5) Respond to Vapi in assistant-response format
  return res.status(200).json({
    response: {
      type: 'assistant-response',
      response: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: replyText,
        }],
      },
    },
    // Best-effort: hint tenantId back to the platform for reuse (if supported).
    conversation: {
      metadata: {
        tenantId,
      },
    },
  });
}

/**
 * Vapi tool endpoint: book_appointment
 * POST /api/vapi/book_appointment
 * 
 * Called by Vapi when the assistant decides to create a booking.
 * Reuses the same booking logic as IVA chat.
 */
router.post('/book_appointment', async (req, res) => {
  const t0 = Date.now();
  try {
    const body = req.body || {};

    const isProd = isProdEnv();
    const tenantResult = await resolveTenantForVapi(body, { allowDbLookup: !isProd });
    const businessId = tenantResult.tenantId || null;

    if (!businessId) {
      return res.status(isProd ? 400 : 200).json({
        success: false,
        error: 'UNKNOWN_TENANT',
        message_cs: 'Omlouvám se, nepodařilo se určit salon pro tento požadavek.',
      });
    }

    // Subscription gating: block booking tools when unsubscribed
    if (!(await isBusinessSubscribed(businessId))) {
      return res.status(200).json({
        success: false,
        error: 'NOT_SUBSCRIBED',
        message_cs: 'Omlouvám se, ale služba IVA není pro tento salon aktivní.',
      });
    }

    // Log incoming request
    console.log('[VAPI_TOOL] book_appointment start', { businessId });
    console.log('[VAPI_TOOL] book_appointment request', {
      businessId,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      serviceId: body.serviceId,
      serviceName: body.serviceName,
      locationName: body.locationName,
      startIso: body.startIso,
      date: body.date,
      dateText: body.dateText,
      time: body.time,
    });

    // Load IVA settings (needed for Google Calendar integration)
    const settingsStart = Date.now();
    const { settings, error: settingsError } = await getIvaSettingsForTenant(businessId);
    console.log('[VAPI_TOOL] timing getIvaSettingsForTenant ms=', Date.now() - settingsStart);
    if (settingsError) {
      console.error('[VAPI_TOOL] Failed to load settings:', settingsError);
      // Continue anyway - booking can still be saved to DB
    }

    // Convert Vapi format to bookingPayload format
    // Vapi might send startIso (ISO datetime) or separate date/time
    let bookingDate = null;
    let bookingTime = null;

    if (body.startIso) {
      // Parse ISO datetime string (e.g. "2025-01-15T14:00:00Z" or "2025-01-15T14:00:00")
      try {
        const dateObj = new Date(body.startIso);
        if (!isNaN(dateObj.getTime())) {
          // Extract date and time components
          const year = dateObj.getFullYear();
          const month = String(dateObj.getMonth() + 1).padStart(2, '0');
          const day = String(dateObj.getDate()).padStart(2, '0');
          const extractedDate = `${year}-${month}-${day}`;
          
          // Validate that date is not in the past
          const today = DateTime.local().setZone('Europe/Prague').startOf('day');
          const extractedDt = DateTime.fromISO(extractedDate).setZone('Europe/Prague').startOf('day');
          
          if (extractedDt.isValid && extractedDt < today) {
            console.warn('[VAPI_TOOL] Warning: startIso date is in the past', { extractedDate, today: today.toISODate() });
            console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
            return res.status(200).json({
              success: false,
              error: 'PAST_DATE',
              message_cs: 'Omlouvám se, ale tenhle termín je podle systému už v minulosti. Zkusme prosím vybrat nějaký jiný, budoucí termín.',
            });
          }
          
          bookingDate = extractedDate;
          
          const hours = String(dateObj.getHours()).padStart(2, '0');
          const minutes = String(dateObj.getMinutes()).padStart(2, '0');
          bookingTime = `${hours}:${minutes}`;
        }
      } catch (e) {
        console.warn('[VAPI_TOOL] Failed to parse startIso:', body.startIso, e);
      }
    }

    // If startIso was not provided or failed to parse, resolve Czech relative dates
    // Use raw date text from Vapi (body.dateText) or fallback to body.date
    if (!bookingDate) {
      const rawDate = body.dateText ?? body.date ?? '';
      const dateResolveStart = Date.now();
      const resolvedDate = resolveCzechDate(rawDate);
      console.log('[VAPI_TOOL] timing resolveCzechDate ms=', Date.now() - dateResolveStart);

      if (!resolvedDate && rawDate) {
        console.warn('[VAPI_TOOL] Could not resolve date from', rawDate);
        console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
        return res.status(200).json({
          success: false,
          error: 'INVALID_DATE',
          message_cs: 'Systém nerozumí zadanému datu. Zkuste ho prosím říct třeba jako „8. 12. 2025" nebo „příští pondělí".',
        });
      }

      // Log resolved date for debugging
      if (rawDate && resolvedDate) {
        console.log('[VAPI_TOOL] resolved date', { rawDate, resolvedDate });
      }

      // Validate that resolved date is not in the past
      if (resolvedDate) {
        const today = DateTime.local().setZone('Europe/Prague').startOf('day');
        const resolvedDt = DateTime.fromISO(resolvedDate).setZone('Europe/Prague').startOf('day');
        
        if (!resolvedDt.isValid) {
          console.warn('[VAPI_TOOL] Invalid resolved date:', resolvedDate);
          console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
          return res.status(200).json({
            success: false,
            error: 'INVALID_DATE',
            message_cs: 'Systém nerozumí zadanému datu. Zkuste ho prosím říct třeba jako „8. 12. 2025" nebo „příští pondělí".',
          });
        }

        if (resolvedDt < today) {
          console.warn('[VAPI_TOOL] Warning: resolved date is in the past', { resolvedDate, today: today.toISODate() });
          console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
          return res.status(200).json({
            success: false,
            error: 'PAST_DATE',
            message_cs: 'Omlouvám se, ale tenhle termín je podle systému už v minulosti. Zkusme prosím vybrat nějaký jiný, budoucí termín.',
          });
        }
      }

      // Use resolved date if we have it, otherwise fallback to body.date (might already be ISO)
      if (resolvedDate) {
        bookingDate = resolvedDate;
      } else if (body.date) {
        bookingDate = body.date;
      }
    }
    
    if (!bookingTime && body.time) {
      bookingTime = body.time;
    }

    // Validate required fields
    if (!bookingDate || !bookingTime) {
      console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
      return res.status(200).json({
        success: false,
        error: 'Missing date or time',
        message_cs: 'Omlouvám se, potřebuji znát datum a čas rezervace. Můžete prosím zopakovat?',
      });
    }

    if (!body.customerName || !body.customerPhone) {
      console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
      return res.status(200).json({
        success: false,
        error: 'Missing customer name or phone',
        message_cs: 'Omlouvám se, potřebuji znát vaše jméno a telefonní číslo pro rezervaci.',
      });
    }

    if (!body.serviceName && !body.serviceId) {
      console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0);
      return res.status(200).json({
        success: false,
        error: 'Missing service',
        message_cs: 'Omlouvám se, potřebuji znát, na jakou službu chcete rezervaci.',
      });
    }

    // Build bookingPayload in the format expected by createBooking
    const bookingPayload = {
      service: body.serviceId || body.serviceName || '',
      client_name: body.customerName,
      client_phone: body.customerPhone,
      client_email: body.customerEmail || null,
      location: body.locationName || '',
      date: bookingDate,
      time: bookingTime,
      duration_minutes: body.durationMinutes || null,
      notes: body.notes || '',
    };

    // Call the existing booking logic (same as IVA chat)
    const bookingStart = Date.now();
    const result = await createBooking(businessId, settings || {}, bookingPayload);
    const bookingDuration = Date.now() - bookingStart;
    console.log('[VAPI_TOOL] timing createBooking ms=', bookingDuration);

    if (!result.ok) {
      // Map error codes to Czech messages
      let errorMessageCs = 'Omlouvám se, rezervaci se nepodařilo vytvořit. Zkuste prosím jiný termín nebo službu.';
      
      if (result.error === 'TIME_CONFLICT') {
        errorMessageCs = 'Bohužel tento termín už je obsazený. Můžu vám nabídnout jiný čas nebo den?';
      } else if (result.error === 'INVALID_DATE') {
        errorMessageCs = 'Omlouvám se, nerozumím přesně datu rezervace. Můžete mi prosím říct konkrétní den?';
      } else if (result.error === 'INVALID_PAYLOAD') {
        errorMessageCs = 'Omlouvám se, některé údaje o rezervaci chybí. Můžete prosím zopakovat všechny potřebné informace?';
      }

      console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0, {
        bookingDurationMs: bookingDuration,
      });

      return res.status(200).json({
        success: false,
        error: result.error || 'Booking failed',
        message_cs: errorMessageCs,
      });
    }

    // Format date/time for Czech confirmation message
    const formatDateForCzech = (dateStr) => {
      if (!dateStr) return '';
      try {
        const [year, month, day] = dateStr.split('-');
        const months = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 
                       'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
        return `${day}. ${months[parseInt(month) - 1]} ${year}`;
      } catch {
        return dateStr;
      }
    };

    const confirmationMessageCs = `Skvěle! Vytvořila jsem pro vás rezervaci na službu ${body.serviceName || body.serviceId || 'zvolenou službu'} dne ${formatDateForCzech(bookingDate)} v ${bookingTime}. Brzy by vám mělo přijít potvrzení e-mailem nebo SMS.`;

    console.log('[VAPI_TOOL] book_appointment total_ms=', Date.now() - t0, {
      bookingDurationMs: bookingDuration,
    });

    return res.status(200).json({
      success: true,
      eventId: result.calendarEventId || null,
      bookingId: result.bookingId || null,
      booking: {
        serviceName: body.serviceName || body.serviceId || '',
        locationName: body.locationName || '',
        startIso: body.startIso || `${bookingDate}T${bookingTime}:00`,
        date: bookingDate,
        time: bookingTime,
        durationMinutes: bookingPayload.duration_minutes || null,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
      },
      message_cs: confirmationMessageCs,
    });
  } catch (err) {
    console.error('[VAPI_TOOL] book_appointment error', {
      err,
      total_ms: Date.now() - t0,
    });
    return res.status(200).json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, došlo k technické chybě. Zkuste to prosím za chvíli znovu.',
    });
  }
});

/**
 * Vapi tool endpoint: find_appointments
 * POST /api/vapi/find_appointments
 * 
 * Finds upcoming bookings for a client by phone number.
 * Returns list of confirmed appointments within date range.
 */
router.post('/find_appointments', async (req, res) => {
  try {
    const body = req.body || {};

    // Log incoming request
    console.log('[VAPI_TOOL] find_appointments request', body);

    const isProd = isProdEnv();
    const tenantResult = await resolveTenantForVapi(body, { allowDbLookup: !isProd });
    const businessId = tenantResult.tenantId || null;

    if (!businessId) {
      console.warn('[VAPI_TOOL] find_appointments: unknown tenant');
      return res.status(isProd ? 400 : 200).json({
        success: false,
        error: 'UNKNOWN_TENANT',
        message_cs: 'Omlouvám se, nepodařilo se určit salon pro tento požadavek.',
      });
    }

    // Subscription gating
    if (!(await isBusinessSubscribed(businessId))) {
      return res.status(200).json({
        success: false,
        error: 'NOT_SUBSCRIBED',
        message_cs: 'Omlouvám se, ale služba IVA není pro tento salon aktivní.',
      });
    }

    // Normalize customerPhone
    const customerPhone = body.customerPhone?.toString()?.trim() || '';
    
    if (!customerPhone || customerPhone.length < 5) {
      return res.status(200).json({
        success: false,
        error: 'INVALID_PHONE',
        message_cs: 'Omlouvám se, potřebuji znát vaše telefonní číslo pro vyhledání rezervací.',
      });
    }

    // Parse date range
    const today = new Date();
    const todayStr = resolveCzechDate('dnes', today);
    
    const fromDate = body.fromDate?.toString() || todayStr;
    const toDate = body.toDate?.toString() || (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 30);
      return resolveCzechDate('dnes', d);
    })();
    
    const limit = parseInt(body.limit?.toString() || '5', 10);

    // Build query - normalize phone for matching (extract last 6-7 digits)
    const phoneDigits = customerPhone.replace(/\D/g, ''); // Remove non-digits
    const lastDigits = phoneDigits.length >= 7 ? phoneDigits.slice(-7) : phoneDigits; // Last 7 digits for matching

    // Build query with phone filter
    // Use ILIKE to match phone numbers that end with the last digits (handles +420, spaces, etc.)
    let query = supabase
      .from('bookings')
      .select('id, service_slug, client_name, client_phone, location, date, time, duration_minutes, status')
      .eq('business_id', businessId)
      .eq('status', 'confirmed')
      .gte('date', fromDate)
      .lte('date', toDate)
      .ilike('client_phone', `%${lastDigits}`)
      .order('date', { ascending: true })
      .order('time', { ascending: true })
      .limit(limit);

    const { data: rows, error } = await query;

    // Handle Supabase query errors
    if (error) {
      console.error('[VAPI_TOOL] find_appointments Supabase query error:', error);
      throw error; // Re-throw to be caught by outer catch block
    }

    // Map rows to response format (matching book_appointment naming convention)
    const appointments = (rows || []).map(row => ({
      id: row.id,
      serviceName: row.service_slug ?? '',
      customerName: row.client_name,
      customerPhone: row.client_phone,
      locationName: row.location || '',
      date: row.date,
      time: row.time,
      durationMinutes: row.duration_minutes,
      status: row.status,
    }));

    // Return success response (even if no appointments found)
    return res.status(200).json({
      success: true,
      appointments: appointments,
      message_cs: appointments.length > 0 
        ? 'Našla jsem vaše nadcházející rezervace.'
        : 'Nemáte žádné nadcházející rezervace.',
    });
  } catch (err) {
    // Only unexpected errors reach here
    console.error('[VAPI_TOOL] find_appointments error', err);
    return res.status(200).json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, nepodařilo se mi načíst vaše rezervace. Zkuste to prosím za chvíli znovu.',
    });
  }
});

/**
 * Helper function to map booking database row to API response format
 */
function mapBookingToResponse(b) {
  return {
    id: b.id,
    serviceName: b.service_slug ?? '',
    customerName: b.client_name,
    customerPhone: b.client_phone,
    locationName: b.location || '',
    date: b.date,
    time: b.time,
    durationMinutes: b.duration_minutes ?? null,
    status: b.status,
  };
}

/**
 * Vapi tool endpoint: update_appointment
 * POST /api/vapi/update_appointment
 * 
 * Cancels or reschedules a specific booking by appointment ID.
 * Supports cancel and reschedule actions.
 */
router.post('/update_appointment', async (req, res) => {
  try {
    const {
      bookingId,
      appointmentId,
      id,
      action,
      date,
      time,
    } = req.body || {};

    // Log incoming request
    console.log('[VAPI_TOOL] update_appointment request', {
      bookingId,
      appointmentId,
      id,
      action,
      date,
      time,
    });

    // Compute finalBookingId from multiple possible field names
    const finalBookingId = bookingId || appointmentId || id;

    // Validate: finalBookingId is required
    if (!finalBookingId) {
      return res.status(200).json({
        success: false,
        error: 'MISSING_APPOINTMENT_ID',
        message_cs: 'Potřebuji ID rezervace, abych s ní mohla pracovat.',
      });
    }

    // Validate: action is required and must be 'cancel' or 'reschedule'
    if (!action || (action !== 'cancel' && action !== 'reschedule')) {
      return res.status(200).json({
        success: false,
        error: 'INVALID_ACTION',
        message_cs: 'Řekněte mi prosím, zda chcete rezervaci zrušit nebo přesunout.',
      });
    }

    const isProd = isProdEnv();
    const body = req.body || {};
    const tenantResult = await resolveTenantForVapi(body, { allowDbLookup: !isProd });
    const businessId = tenantResult.tenantId || null;

    if (!businessId) {
      return res.status(isProd ? 400 : 200).json({
        success: false,
        error: 'UNKNOWN_TENANT',
        message_cs: 'Omlouvám se, nepodařilo se určit salon pro tento požadavek.',
      });
    }

    // Subscription gating
    if (!(await isBusinessSubscribed(businessId))) {
      return res.status(200).json({
        success: false,
        error: 'NOT_SUBSCRIBED',
        message_cs: 'Omlouvám se, ale služba IVA není pro tento salon aktivní.',
      });
    }

    // Load IVA settings (needed for Google Calendar integration)
    const { settings, error: settingsError } = await getIvaSettingsForTenant(businessId);
    if (settingsError) {
      console.error('[VAPI_TOOL] Failed to load settings:', settingsError);
      // Continue anyway - booking can still be updated in DB
    }

    // Load the booking by id + business_id
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', finalBookingId)
      .eq('business_id', businessId)
      .single();

    if (bookingError || !booking) {
      console.error('[VAPI_TOOL] Booking not found:', bookingError);
      return res.status(200).json({
        success: false,
        error: 'BOOKING_NOT_FOUND',
        message_cs: 'Omlouvám se, tuto rezervaci jsem v systému nenašla.',
      });
    }

    // Handle cancel action
    if (action === 'cancel') {
      // Update booking status to cancelled
      const { error: updateError } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', finalBookingId);

      if (updateError) {
        console.error('[VAPI_TOOL] Error updating booking status:', updateError);
        return res.status(200).json({
          success: false,
          error: 'UPDATE_FAILED',
          message_cs: 'Omlouvám se, zrušení rezervace se nepodařilo dokončit.',
        });
      }

      // Delete calendar event if exists (log errors but don't fail the request)
      if (booking.calendar_event_id) {
        try {
          await cancelCalendarEvent(booking.calendar_event_id, settings);
          console.log('[VAPI_TOOL] Cancelled calendar event:', booking.calendar_event_id);
        } catch (calendarError) {
          console.error('[VAPI_TOOL] Error cancelling calendar event:', calendarError);
          // Continue - calendar error should not fail the entire request
        }
      }

      console.log('[VAPI_TOOL] Cancelled booking:', finalBookingId);

      return res.status(200).json({
        success: true,
        message_cs: 'Rezervace byla úspěšně zrušena.',
      });
    }

    // Handle reschedule action
    if (action === 'reschedule') {
      // Validate: reschedule requires both date and time
      if (!date || !time) {
        return res.status(200).json({
          success: false,
          error: 'MISSING_NEW_TIME',
          message_cs: 'Pro změnu termínu potřebuji nový den a čas.',
        });
      }

      // Resolve date using existing Czech date helper (same as book_appointment)
      const resolvedDate = resolveCzechDate(date);
      if (!resolvedDate) {
        return res.status(200).json({
          success: false,
          error: 'INVALID_DATE',
          message_cs: 'Systém nerozumí zadanému datu. Zkuste ho prosím říct třeba jako „8. 12. 2025" nebo „příští pondělí".',
        });
      }

      // Validate that resolved date is not in the past
      const today = DateTime.local().setZone('Europe/Prague').startOf('day');
      const resolvedDt = DateTime.fromISO(resolvedDate).setZone('Europe/Prague').startOf('day');
      
      if (!resolvedDt.isValid) {
        console.warn('[VAPI_TOOL] Invalid resolved date:', resolvedDate);
        return res.status(200).json({
          success: false,
          error: 'INVALID_DATE',
          message_cs: 'Systém nerozumí zadanému datu. Zkuste ho prosím říct třeba jako „8. 12. 2025" nebo „příští pondělí".',
        });
      }

      if (resolvedDt < today) {
        console.warn('[VAPI_TOOL] Warning: resolved date is in the past', { resolvedDate, today: today.toISODate() });
        return res.status(200).json({
          success: false,
          error: 'PAST_DATE',
          message_cs: 'Omlouvám se, ale tenhle termín je podle systému už v minulosti. Zkusme prosím vybrat nějaký jiný, budoucí termín.',
        });
      }

      // Normalize time (ensure HH:mm format)
      const normalizedTime = String(time).trim();
      if (!/^\d{1,2}:\d{2}$/.test(normalizedTime)) {
        return res.status(200).json({
          success: false,
          error: 'INVALID_TIME',
          message_cs: 'Omlouvám se, čas musí být ve formátu HH:MM, například "14:30".',
        });
      }

      // Check slot availability using the same helper as book_appointment
      const durationMinutes = booking.duration_minutes || 60;
      const availability = await isSlotAvailable(
        {
          business_id: businessId,
          date: resolvedDate,
          time: normalizedTime,
          duration_minutes: durationMinutes,
        },
        settings || {}
      );

      if (availability.ok && !availability.available) {
        return res.status(200).json({
          success: false,
          error: 'TIME_NOT_AVAILABLE',
          message_cs: 'V tomto termínu už je plno. Zkuste prosím jiný čas.',
        });
      }

      // Update booking date/time and status to 'rescheduled'
      const payload = {
        date: resolvedDate,
        time: normalizedTime,
        status: 'rescheduled',
      };

      const { error: updateError } = await supabase
        .from('bookings')
        .update(payload)
        .eq('id', finalBookingId);

      if (updateError) {
        console.error('[VAPI_TOOL] Error updating booking date/time:', updateError);
        return res.status(200).json({
          success: false,
          error: 'UPDATE_FAILED',
          message_cs: 'Omlouvám se, změnu rezervace se nepodařilo dokončit.',
        });
      }

      // Update calendar event if exists (log errors but don't fail the request)
      if (booking.calendar_event_id) {
        try {
          await rescheduleCalendarEvent(
            booking.calendar_event_id,
            resolvedDate,
            normalizedTime,
            durationMinutes,
            settings
          );
          console.log('[VAPI_TOOL] Rescheduled calendar event:', booking.calendar_event_id);
        } catch (calendarError) {
          console.error('[VAPI_TOOL] Error rescheduling calendar event:', calendarError);
          // Continue - calendar error should not fail the entire request
        }
      }

      console.log('[VAPI_TOOL] Rescheduled booking:', finalBookingId);

      return res.status(200).json({
        success: true,
        message_cs: `Rezervaci jsem přesunula na ${resolvedDate} v ${normalizedTime}.`,
      });
    }
  } catch (err) {
    console.error('[VAPI_TOOL] update_appointment error', err);
    return res.status(200).json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, při práci s rezervací se něco pokazilo. Zkuste to prosím za chvíli znovu.',
    });
  }
});

export default router;

// VAPI_TOOL timing logs:
// - "[VAPI_TOOL] timing getIvaSettingsForTenant ms=": DB lookup for IVA settings
// - "[VAPI_TOOL] timing resolveCzechDate ms=": date/time resolution from Czech text
// - "[VAPI_TOOL] timing createBooking ms=": full booking helper (includes Google Calendar)
// - "[VAPI_TOOL] book_appointment total_ms=": full HTTP handler time

// VAPI_TOOL endpoints:
// /api/vapi/find_appointments
//   - POST with body: { customerPhone, businessId?, fromDate?, toDate?, limit? }
//   - Returns { success, appointments: [...] }
//
// /api/vapi/update_appointment
//   - POST with body: { businessId?, bookingId, action: 'cancel'|'reschedule', newDate?, newTime? }
//   - Returns { success, action, booking?, message_cs }

