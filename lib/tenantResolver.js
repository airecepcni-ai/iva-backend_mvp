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
  if (!payload || typeof payload !== 'object') return { to: null, sourcePath: null };

  const p = payload;
  const msg = p.message ?? null;
  const call = msg?.call ?? p.call ?? null;
  const customer = msg?.customer ?? p.customer ?? null;
  const twilio = p.twilio ?? msg?.twilio ?? null;

  // Priority order (most explicit destination first).
  const candidates = [
    { path: 'payload.to', value: p.to },
    { path: 'payload.To', value: p.To },
    { path: 'payload.message.to', value: msg?.to },
    { path: 'payload.message.To', value: msg?.To },

    // Vapi-ish call objects
    { path: 'payload.message.call.to', value: msg?.call?.to },
    { path: 'payload.call.to', value: p?.call?.to },
    { path: 'payload.message.call.toNumber', value: msg?.call?.toNumber },
    { path: 'payload.message.call.to_number', value: msg?.call?.to_number },
    { path: 'payload.call.toNumber', value: p?.call?.toNumber },
    { path: 'payload.call.to_number', value: p?.call?.to_number },

    // Some providers use "destination"
    { path: 'payload.message.call.destination', value: msg?.call?.destination },
    { path: 'payload.message.call.destinationNumber', value: msg?.call?.destinationNumber },
    { path: 'payload.message.call.destination_number', value: msg?.call?.destination_number },
    { path: 'payload.call.destination', value: p?.call?.destination },
    { path: 'payload.call.destinationNumber', value: p?.call?.destinationNumber },
    { path: 'payload.call.destination_number', value: p?.call?.destination_number },

    // Twilio-ish nested blobs
    { path: 'payload.twilio.to', value: twilio?.to },
    { path: 'payload.twilio.To', value: twilio?.To },

    // Lower-priority fallbacks (can be caller in some payloads; log visibility helps)
    { path: 'payload.message.customer.number', value: customer?.number },
    { path: 'payload.message.customer.phoneNumber', value: customer?.phoneNumber },
    { path: 'payload.customer.number', value: p?.customer?.number },
    { path: 'payload.customer.phoneNumber', value: p?.customer?.phoneNumber },

    { path: 'payload.message.call.customer.number', value: msg?.call?.customer?.number },
    { path: 'payload.message.call.customer.phoneNumber', value: msg?.call?.customer?.phoneNumber },
    { path: 'payload.message.call.customer.phone_number', value: msg?.call?.customer?.phone_number },
    { path: 'payload.call.customer.number', value: p?.call?.customer?.number },
    { path: 'payload.call.customer.phoneNumber', value: p?.call?.customer?.phoneNumber },
    { path: 'payload.call.customer.phone_number', value: p?.call?.customer?.phone_number },
  ];

  for (const c of candidates) {
    if (typeof c.value === 'string' && c.value.trim().length > 0) {
      return { to: c.value.trim(), sourcePath: c.path };
    }
  }

  // Final fallback: keep old behavior for any callers that relied on this.
  const legacy = pickFirstString(
    p.to,
    p.To,
    msg?.to,
    msg?.To,
    call?.to,
    call?.toNumber,
    call?.to_number,
    call?.customer?.number,
    call?.customer?.phoneNumber,
    call?.customer?.phone_number,
    twilio?.to,
    twilio?.To
  );
  return legacy ? { to: legacy, sourcePath: 'legacy' } : { to: null, sourcePath: null };
}

export function extractCalledNumber(payload) {
  return extractCalledNumberDetailed(payload).to;
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
 * - { ok: false, error: 'missing_to'|'unknown_number'|'not_subscribed' }
 */
export async function resolveBusinessByCalledNumber(payload) {
  const extracted = extractCalledNumberDetailed(payload);
  const rawTo = extracted.to;
  if (!rawTo) {
    return { ok: false, error: 'missing_to', to: null, sourcePath: extracted.sourcePath };
  }

  const to = normalizeE164Like(rawTo);
  if (!to) {
    return { ok: false, error: 'missing_to', to: null, sourcePath: extracted.sourcePath };
  }

  const { data: row, error } = await supabase
    .from('businesses')
    .select('id, name, is_subscribed, vapi_phone')
    .eq('vapi_phone', to)
    .limit(1)
    .maybeSingle();

  if (error) {
    // Treat DB errors as internal but keep response safe.
    return { ok: false, error: 'db_error', to, sourcePath: extracted.sourcePath };
  }

  // Dev-only fallback to legacy businesses.phone (deprecated).
  if (!row?.id) {
    const env = process.env.NODE_ENV;
    const isProd = env === 'production';
    if (isProd) {
      return { ok: false, error: 'unknown_number', to, sourcePath: extracted.sourcePath };
    }

    const fb = await supabase
      .from('businesses')
      .select('id, name, is_subscribed, phone')
      .eq('phone', to)
      .limit(1)
      .maybeSingle();

    if (fb.error) {
      return { ok: false, error: 'db_error', to, sourcePath: extracted.sourcePath };
    }
    if (!fb.data?.id) {
      return { ok: false, error: 'unknown_number', to, sourcePath: extracted.sourcePath };
    }

    const isSubscribed = fb.data.is_subscribed === true;
    if (!isSubscribed) {
      return {
        ok: false,
        error: 'not_subscribed',
        to,
        sourcePath: extracted.sourcePath,
        businessId: fb.data.id,
        businessName: fb.data.name ?? null,
        isSubscribed: false,
        fallbackUsed: 'phone',
      };
    }

    return {
      ok: true,
      to,
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
      to,
      sourcePath: extracted.sourcePath,
      businessId: row.id,
      businessName: row.name ?? null,
      isSubscribed: false,
      fallbackUsed: null,
    };
  }

  return {
    ok: true,
    to,
    sourcePath: extracted.sourcePath,
    businessId: row.id,
    businessName: row.name ?? null,
    isSubscribed: true,
    fallbackUsed: null,
  };
}


