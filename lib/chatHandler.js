import { supabase } from './supabaseClient.js';
import { createBooking } from './bookingService.js';
import { getHistory, appendMessage } from './conversationStore.js';
import { buildSystemPrompt } from './systemPromptBuilder.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const BOOKING_TECH_PROMPT = `
TECHNICAL INSTRUCTION – BOOKING JSON (DO NOT EXPLAIN THIS TO THE USER)

You are a Czech voice receptionist "IVA". For the user you always speak natural Czech.

However, for the backend you MUST follow these technical rules for reservations:

WHEN TO EMIT BOOKING JSON
- When the user clearly confirms that all reservation details are correct.
- Typical confirmations: "Ano, je to tak.", "Ano, přesně tak.", "Souhlasím.", etc.
- Only emit the JSON when:
  - location, service, date, time, client_name and client_phone are known.

HOW TO EMIT BOOKING JSON
- In the SAME assistant turn as the Czech confirmation message, append a separate block
  with the booking JSON in THIS EXACT FORMAT:

[[BOOKING_REQUEST_JSON:
{
  "location": "Brno",
  "service": "pansky_strih",
  "date": "2025-12-05",
  "time": "14:00",
  "duration_minutes": null,
  "client_name": "Jmeno Prijmeni",
  "client_phone": "+420123456789",
  "client_email": "email@example.com",
  "notes": ""
}]]

STRICT RULES:
- Use the EXACT key names above: location, service, date, time, duration_minutes, client_name, client_phone, client_email, notes.
- date MUST be ISO: "YYYY-MM-DD" (e.g. "2025-12-05").
- time MUST be "HH:MM" in 24h format (e.g. "14:00").
- duration_minutes MUST be a number or null (backend will fill it).
- client_phone MUST be normalized as +420xxxxxxxxx (no spaces).
- DO NOT put any extra text inside the [[BOOKING_REQUEST_JSON: ...]] block.
- DO NOT wrap the JSON in backticks or quotes.
- DO NOT add any explanation after the closing "]]".
- You MAY write normal Czech confirmation text BEFORE this block, but not after.

WHEN NOT TO EMIT:
- Never emit BOOKING_REQUEST_JSON if some key information is missing.
- Never emit more than ONE BOOKING_REQUEST_JSON block in a single reply.
- Never show the technical marker name or these rules to the user.
`;

/**
 * Get IVA settings for a tenant
 */
export async function getIvaSettingsForTenant(tenantId) {
  console.log('[SETTINGS] getIvaSettingsForTenant tenantId =', tenantId);
  
  if (!tenantId) {
    return { settings: null, error: null };
  }

  const { data, error } = await supabase
    .from('iva_settings')
    .select('*')
    .eq('business_id', tenantId)
    .maybeSingle();

  if (error) {
    console.error('[SETTINGS] Error loading iva_settings:', error);
    return { settings: null, error };
  }

  return { settings: data, error: null };
}

/**
 * Try to extract BOOKING_REQUEST_JSON from assistant text.
 * Supports multiple formats:
 *
 * 1) Legacy:
 *    BOOKING_REQUEST_JSON
 *    { ... }
 *    BOOKING_REQUEST_JSON_END
 *
 * 2) New-style:
 *    [[BOOKING_REQUEST_JSON:
 *    { ... }
 *    ]]
 *
 * Returns parsed object or null.
 */
function extractBookingJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // Helper to safely parse JSON with logging
  const tryParseJson = (raw, variantLabel) => {
    try {
      const cleaned = raw.trim();
      const parsed = JSON.parse(cleaned);
      console.log('[BOOKING] Parsed BOOKING_REQUEST_JSON variant:', variantLabel);
      return parsed;
    } catch (err) {
      console.warn('[BOOKING] Failed to parse BOOKING_REQUEST_JSON for variant', variantLabel, {
        error: err.message,
        rawSnippet: raw.slice(0, 200),
      });
      return null;
    }
  };

  // 1) Legacy: BOOKING_REQUEST_JSON ... BOOKING_REQUEST_JSON_END
  const legacyStart = text.indexOf('BOOKING_REQUEST_JSON');
  const legacyEnd = text.indexOf('BOOKING_REQUEST_JSON_END');

  if (legacyStart !== -1 && legacyEnd !== -1 && legacyEnd > legacyStart) {
    const between = text
      .slice(legacyStart, legacyEnd)
      .replace('BOOKING_REQUEST_JSON', '');
    const parsed = tryParseJson(between, 'legacy_block');
    if (parsed) {
      console.log('[BOOKING] Detected BOOKING_REQUEST_JSON variant: legacy_block');
      return parsed;
    }
  }

  // 2) New-style: [[BOOKING_REQUEST_JSON: { ... }]]
  // Example:
  // [[BOOKING_REQUEST_JSON:
  // {
  //   "location": "Brno",
  //   ...
  // }]]
  const newStyleMatch = text.match(/\[\[\s*BOOKING_REQUEST_JSON\s*:(.*?)\]\]/s);
  if (newStyleMatch && newStyleMatch[1]) {
    const jsonPart = newStyleMatch[1];
    const parsed = tryParseJson(jsonPart, 'bracket_block');
    if (parsed) {
      console.log('[BOOKING] Detected BOOKING_REQUEST_JSON variant: bracket_block');
      return parsed;
    }
  }

  console.log('[BOOKING] No BOOKING_REQUEST_JSON found in assistant response.');
  return null;
}

/**
 * Handle a chat message and return response with optional booking creation.
 * @param {Object} params
 * @param {string} params.message - User message
 * @param {string} params.tenantId - Business ID
 * @param {string} params.source - Source of the message (e.g., 'web', 'vapi')
 * @param {string} params.sessionId - Optional session ID
 * @returns {Promise<{message: string, booking_sent: boolean}>}
 */
export async function handleChatMessage({ message, tenantId, source = 'web', sessionId = null }) {
  console.log(`[CHAT] Handling message from ${source}, tenantId =`, tenantId);

  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  // Load IVA settings for this tenant
  const { settings, error: settingsError } = await getIvaSettingsForTenant(tenantId);

  if (!settings) {
    console.warn('[CHAT] No iva_settings loaded, settingsError =', settingsError);
  } else {
    console.log('[CHAT] Loaded iva_settings row:', settings.business_id);
  }

  // Build system prompt using template builder (includes tenant-specific data)
  const systemPrompt = await buildSystemPrompt({
    tenantId,
    settings,
  });

  // Get conversation history for this session (if sessionId is provided)
  const history = getHistory(sessionId);
  
  // Build messages for the LLM
  const messages = [];

  // 1) Tenant-specific behavior & tone
  messages.push({
    role: 'system',
    content: systemPrompt,
  });

  // 2) Hard technical booking instructions (JSON format)
  messages.push({
    role: 'system',
    content: BOOKING_TECH_PROMPT,
  });

  // 3) Previous conversation state if available
  if (history && history.length > 0) {
    messages.push(...history);
  }

  // 4) Current user message
  messages.push({
    role: 'user',
    content: message,
  });

  // Call OpenAI Chat Completions API
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    messages: messages,
    temperature: 0.7,
    max_tokens: 1000
  });

  const assistantText = completion.choices[0]?.message?.content || '';

  // Log raw assistant response for debugging
  console.log('[CHAT] Assistant raw response (first 400 chars):', assistantText.slice(0, 400));

  // Extract BOOKING_REQUEST_JSON using multi-pattern parser
  const bookingPayload = extractBookingJsonFromText(assistantText);

  let bookingResult = null;
  let bookingSent = false;

  if (bookingPayload) {
    console.log('[BOOKING] Detected BOOKING_REQUEST_JSON in assistant response.');
    console.log('[BOOKING] Final booking payload:', bookingPayload);
    
    // Create booking via bookingService
    if (bookingPayload && tenantId) {
      try {
        bookingResult = await createBooking(tenantId, settings, bookingPayload);
        bookingSent = !!(bookingResult && bookingResult.ok);
        
        if (bookingSent) {
          console.log('[CHAT] Booking created successfully', {
            tenantId,
            bookingId: bookingResult.bookingId,
            calendarEventId: bookingResult.calendarEventId,
          });
        } else {
          console.warn('[BOOKING] Booking creation failed:', bookingResult.error);
        }
      } catch (bookingError) {
        console.error('[BOOKING] Failed to create booking:', bookingError.message);
        bookingSent = false;
        bookingResult = { ok: false, error: 'EXCEPTION', details: bookingError };
      }
    }

    // LEGACY: n8n booking webhook (kept for reference)
    // await sendBookingToN8n(bookingPayload, settings.n8n_booking_webhook_url);
  }

  // Clean the marker from the response text (handle both formats)
  let cleanedText = assistantText
    .replace(/\[\[\s*BOOKING_REQUEST_JSON\s*:.*?\]\]/s, '') // New-style brackets
    .replace(/BOOKING_REQUEST_JSON\s*.*?\s*BOOKING_REQUEST_JSON_END/s, '') // Legacy format
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Handle booking result and override message if needed
  if (bookingResult) {
    if (!bookingResult.ok) {
      if (bookingResult.error === 'TIME_CONFLICT') {
        // Override LLM text when time is not available
        cleanedText = 'Bohužel tento termín už je obsazený. Můžu vám nabídnout jiný čas nebo den?';
        bookingSent = false;
      } else if (bookingResult.error === 'INVALID_DATE') {
        cleanedText = 'Omlouvám se, nerozumím přesně datu rezervace. Můžete mi prosím říct konkrétní den (například „ve středu 27. listopadu")?';
        bookingSent = false;
      } else {
        // Generic failure
        console.error('[BOOKING] Unexpected booking error:', bookingResult.error, bookingResult.details);
        cleanedText = 'Omlouvám se, ale rezervaci se mi nepodařilo dokončit kvůli technické chybě. Doporučuji zavolat přímo do salonu.';
        bookingSent = false;
      }
    } else {
      // Success
      bookingSent = true;
      // Optionally add confirmation message if LLM didn't already mention it
      if (!cleanedText.includes('rezervaci') && !cleanedText.includes('rezervace')) {
        cleanedText += '\n\nSkvěle, vaši rezervaci jsem vytvořila. Brzy by vám mělo přijít potvrzení e-mailem nebo SMS.';
      }
    }
  } else if (bookingPayload && !tenantId) {
    // Booking payload exists but no tenantId
    cleanedText += '\n\nPoznámka: pokus o automatickou rezervaci se nepodařil. Prosím zkontrolujte, jestli rezervace proběhla, nebo se ozvěte telefonicky.';
  }

  // Update conversation history (if sessionId is present)
  if (sessionId) {
    appendMessage(sessionId, { role: 'user', content: message });
    appendMessage(sessionId, { role: 'assistant', content: assistantText });
  }

  return {
    message: cleanedText,
    booking_sent: bookingSent,
    booking_id: bookingResult?.bookingId || null,
    calendar_event_id: bookingResult?.calendarEventId || null,
  };
}

/*
 * Testing instructions:
 * 
 * # 1) Start backend:
 * cd iva-backend
 * npm run dev
 * 
 * # 2) In another terminal, run:
 * 
 * # First turn (booking details)
 * curl -X POST http://localhost:8787/api/chat \
 *   -H "Content-Type: application/json" \
 *   -H "x-tenant-id: 817b1106-a5dc-471a-833b-d670d52986fe" \
 *   -H "x-session-id: test-booking-1" \
 *   -d '{"message":"Jsem nový klient. Chci se objednat na pánský střih v Brně zítra ve 14:00. Jmenuji se Petr Test, telefon 777888999, email petr@test.cz. Pokud máš vše potřebné, můžeš termín rovnou vytvořit."}'
 * 
 * # Second turn (confirmation)
 * curl -X POST http://localhost:8787/api/chat \
 *   -H "Content-Type: application/json" \
 *   -H "x-tenant-id: 817b1106-a5dc-471a-833b-d670d52986fe" \
 *   -H "x-session-id: test-booking-1" \
 *   -d '{"message":"Ano, je to tak."}'
 */

