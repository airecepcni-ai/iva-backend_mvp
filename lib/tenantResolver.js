import { supabase } from './supabaseClient.js';

function pickFirstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return null;
}

/**
 * Minimal normalization consistent with what we store in DB:
 * - trim
 * - remove spaces/hyphens
 * - convert leading 00 -> +
 */
export function normalizeE164Like(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/[\s-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) return s; // keep as-is; caller can decide to reject
  return s;
}

/**
 * Attempts to extract the called/destination number from various provider payload shapes.
 * We intentionally keep this permissive because providers (Twilio/Vapi) differ.
 */
export function extractCalledNumberDetailed(payload) {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'invalid_payload', calledNumber: null, sourcePath: null };
    }

    const body = payload;
    const msg = body.message ?? null;
    const call = msg?.call ?? body.call ?? null;

    // If this looks like a Vapi Server URL payload, route ONLY by the inbound business number.
    // Important: do NOT use customer/caller number as "called number" (that causes wrong tenant).
    const looksLikeVapi = !!msg && typeof msg === 'object' && (msg.type || msg.call);

    const candidates = looksLikeVapi
      ? [
          { path: 'body.message.call.phoneNumber.number', value: body?.message?.call?.phoneNumber?.number },
          { path: 'body.message.call.phoneNumber', value: typeof body?.message?.call?.phoneNumber === 'string' ? body.message.call.phoneNumber : null },
          { path: 'body.to', value: body?.to },
        ]
      : [
          // Generic/provider variations (keep permissive for non-Vapi sources)
          { path: 'body.to', value: body?.to },
          { path: 'body.To', value: body?.To },
          { path: 'body.message.to', value: msg?.to },
          { path: 'body.message.To', value: msg?.To },
          { path: 'body.call.to', value: call?.to },
        ];

    for (const c of candidates) {
      if (typeof c.value === 'string' && c.value.trim().length > 0) {
        return { ok: true, calledNumber: c.value.trim(), sourcePath: c.path };
      }
    }

    // Final fallback: keep old behavior for any callers that relied on this.
    const legacy = pickFirstString(
      body.to,
      body.To,
      msg?.to,
      msg?.To,
      call?.to,
      call?.toNumber,
      call?.to_number
    );

    return legacy
      ? { ok: true, calledNumber: legacy, sourcePath: 'legacy' }
      : { ok: true, calledNumber: null, sourcePath: null };
  } catch (e) {
    return {
      ok: false,
      error: 'extract_failed',
      calledNumber: null,
      sourcePath: null,
      message: e?.message || String(e),
    };
  }
}

export function extractCalledNumber(payload) {
  return extractCalledNumberDetailed(payload).calledNumber;
}

/**
 * Resolve tenant/business by called phone number (public.businesses.vapi_phone).
 *
 * NOTE:
 * - In production, routing MUST be based only on vapi_phone to prevent collisions
 *   with public contact numbers (businesses.phone).
 * - In dev, we allow an optional fallback to legacy businesses.phone to avoid
 *   breaking existing local setups; callers should log a warning when that happens.
 *
 * Returns:
 * - { ok: true, businessId, businessName, isSubscribed }
 * - { ok: false, error: 'missing_called_number'|'unknown_number'|'not_subscribed' }
 */
export async function resolveBusinessByCalledNumber(payload) {
  const extracted = extractCalledNumberDetailed(payload);
  const rawCalledNumber = extracted.calledNumber;
  if (!rawCalledNumber) {
    return { ok: false, error: 'missing_called_number', calledNumber: null, sourcePath: extracted.sourcePath };
  }

  const calledNumber = normalizeE164Like(rawCalledNumber);
  if (!calledNumber) {
    return { ok: false, error: 'missing_called_number', calledNumber: null, sourcePath: extracted.sourcePath };
  }

  const { data: row, error } = await supabase
    .from('businesses')
    .select('id, name, is_subscribed, vapi_phone')
    .eq('vapi_phone', calledNumber)
    .limit(1)
    .maybeSingle();

  if (error) {
    // Treat DB errors as internal but keep response safe.
    return { ok: false, error: 'db_error', calledNumber, sourcePath: extracted.sourcePath };
  }

  // Dev-only fallback to legacy businesses.phone (deprecated).
  if (!row?.id) {
    const env = process.env.NODE_ENV;
    const isProd = env === 'production';
    if (isProd) {
      return { ok: false, error: 'unknown_number', calledNumber, sourcePath: extracted.sourcePath };
    }

    const fb = await supabase
      .from('businesses')
      .select('id, name, is_subscribed, phone')
      .eq('phone', calledNumber)
      .limit(1)
      .maybeSingle();

    if (fb.error) {
      return { ok: false, error: 'db_error', calledNumber, sourcePath: extracted.sourcePath };
    }
    if (!fb.data?.id) {
      return { ok: false, error: 'unknown_number', calledNumber, sourcePath: extracted.sourcePath };
    }

    const isSubscribed = fb.data.is_subscribed === true;
    if (!isSubscribed) {
      return {
        ok: false,
        error: 'not_subscribed',
        calledNumber,
        sourcePath: extracted.sourcePath,
        businessId: fb.data.id,
        businessName: fb.data.name ?? null,
        isSubscribed: false,
        fallbackUsed: 'phone',
      };
    }

    return {
      ok: true,
      calledNumber,
      sourcePath: extracted.sourcePath,
      businessId: fb.data.id,
      businessName: fb.data.name ?? null,
      isSubscribed: true,
      fallbackUsed: 'phone',
    };
  }

  const isSubscribed = row.is_subscribed === true;
  if (!isSubscribed) {
    return {
      ok: false,
      error: 'not_subscribed',
      calledNumber,
      sourcePath: extracted.sourcePath,
      businessId: row.id,
      businessName: row.name ?? null,
      isSubscribed: false,
      fallbackUsed: null,
    };
  }

  return {
    ok: true,
    calledNumber,
    sourcePath: extracted.sourcePath,
    businessId: row.id,
    businessName: row.name ?? null,
    isSubscribed: true,
    fallbackUsed: null,
  };
}


