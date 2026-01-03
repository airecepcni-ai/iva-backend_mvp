import { supabase } from './supabaseClient.js';
import { isSlotAvailable, createCalendarEvent, cancelCalendarEvent, rescheduleCalendarEvent } from './googleCalendar.js';
import { parseRelativeDate } from './dateUtils.js';

// Default service durations (fallback if not found in Supabase)
const DEFAULT_SERVICE_DURATIONS = {
  damsky_strih: 60,
  pansky_strih: 30,
  barveni: 90,
  barveni_vlasu: 90,
  foukana: 45,
  melir: 120,
  balayage: 150,
};

// Fallback used if we find nothing at all
const GLOBAL_FALLBACK_DURATION_MINUTES = 60;

/**
 * Resolve service duration in minutes for a given business and service identifier.
 * Tries:
 *  1) Supabase `services` table: duration_minutes where business_id = tenantId AND (slug OR name matches)
 *  2) DEFAULT_SERVICE_DURATIONS mapping
 *  3) GLOBAL_FALLBACK_DURATION_MINUTES
 */
async function resolveServiceDurationMinutes(tenantId, serviceCodeOrName) {
  try {
    if (!tenantId || !serviceCodeOrName) {
      console.warn('[BOOKING] Missing tenantId or service code for duration, using global fallback.');
      return GLOBAL_FALLBACK_DURATION_MINUTES;
    }

    const normalizedCode = serviceCodeOrName.toLowerCase().trim();

    // 1) Try Supabase `services` table
    const { data, error } = await supabase
      .from('services')
      .select('name, slug, duration_minutes')
      .eq('business_id', tenantId);

    if (error) {
      console.error('[BOOKING] Error fetching services for duration:', error);
    } else if (data && data.length > 0) {
      // Try to find best match by slug or name
      const match = data.find((svc) => {
        const slug = (svc.slug || '').toLowerCase();
        const name = (svc.name || '').toLowerCase();
        return slug === normalizedCode || name.includes(normalizedCode) || normalizedCode.includes(slug);
      });

      if (match && match.duration_minutes && match.duration_minutes > 0) {
        console.log('[BOOKING] Using duration from services table:', match.duration_minutes, 'minutes for service', normalizedCode);
        return match.duration_minutes;
      }
    }

    // 2) Try in-code default map
    if (DEFAULT_SERVICE_DURATIONS[normalizedCode]) {
      console.log('[BOOKING] Using default duration for service', normalizedCode, '→', DEFAULT_SERVICE_DURATIONS[normalizedCode], 'minutes');
      return DEFAULT_SERVICE_DURATIONS[normalizedCode];
    }

    // 3) Global fallback
    console.warn('[BOOKING] No duration found for service', normalizedCode, '→ using global fallback', GLOBAL_FALLBACK_DURATION_MINUTES, 'minutes');
    return GLOBAL_FALLBACK_DURATION_MINUTES;
  } catch (err) {
    console.error('[BOOKING] Exception resolving duration, using global fallback:', err);
    return GLOBAL_FALLBACK_DURATION_MINUTES;
  }
}

/**
 * Creates a booking in Supabase and Google Calendar.
 * @param {string} tenantId - Business ID (UUID)
 * @param {Object} settings - IVA settings object (may contain google_calendar_id)
 * @param {Object} bookingPayload - Booking payload from BOOKING_REQUEST_JSON marker
 * @returns {Promise<{ok: boolean, error?: string, bookingId?: string, calendarEventId?: string, details?: Object}>}
 * 
 * Test flow (PowerShell):
 * 1) iwr ... /api/chat with x-session-id "test-booking-1" and full booking details
 * 2) iwr ... /api/chat with SAME x-session-id and message "Ano, je to tak."
 * Then check backend logs for [BOOKING] and [GCAL], and Supabase "bookings" table for new row.
 */
export async function createBooking(tenantId, settings, bookingPayload) {
  if (!tenantId) {
    return { ok: false, error: 'MISSING_TENANT_ID' };
  }

  if (!bookingPayload || !bookingPayload.service || !bookingPayload.client_name || !bookingPayload.client_phone) {
    return { ok: false, error: 'INVALID_PAYLOAD', details: 'Missing required fields' };
  }

  // Resolve duration_minutes if missing
  let durationMinutes = bookingPayload.duration_minutes;
  if (!durationMinutes || durationMinutes <= 0) {
    durationMinutes = await resolveServiceDurationMinutes(tenantId, bookingPayload.service);
    console.log('[BOOKING] Resolved duration_minutes:', durationMinutes, 'for service:', bookingPayload.service);
  }

  // Parse relative date (e.g. "zítra" -> "2025-01-15")
  const parsedDate = parseRelativeDate(bookingPayload.date);
  if (!parsedDate) {
    console.warn('[BOOKING] Failed to parse date from payload:', bookingPayload.date);
    return { ok: false, error: 'INVALID_DATE', details: bookingPayload.date };
  }

  // Normalize the booking
  const booking = {
    business_id: tenantId,
    client_name: bookingPayload.client_name,
    client_phone: bookingPayload.client_phone,
    client_email: bookingPayload.client_email || null,
    service_slug: bookingPayload.service,
    location: bookingPayload.location || '',
    date: parsedDate,
    time: bookingPayload.time, // assume "HH:MM"
    duration_minutes: durationMinutes,
    status: 'confirmed',
    raw_booking_json: bookingPayload
  };

  console.log('[BOOKING] Final booking payload (before availability check):', {
    ...booking,
    original_date: bookingPayload.date,
  });

  // Check availability in Google Calendar
  const availability = await isSlotAvailable(booking, settings);

  if (availability.ok && !availability.available) {
    console.log('[BOOKING] Time conflict detected, not creating booking');
    return { ok: false, error: 'TIME_CONFLICT', details: availability };
  }

  if (!availability.ok && availability.reason === 'MISSING_CONFIG') {
    console.warn('[BOOKING] Availability check skipped due to missing config – proceeding anyway');
    // continue and create booking, but log
  }

  // Insert booking into Supabase
  const { data, error } = await supabase
    .from('bookings')
    .insert({
      business_id: booking.business_id,
      calendar_event_id: null, // will be filled after successful event creation
      client_name: booking.client_name,
      client_phone: booking.client_phone,
      client_email: booking.client_email,
      service_slug: booking.service_slug,
      location: booking.location,
      date: booking.date,
      time: booking.time,
      duration_minutes: booking.duration_minutes,
      status: booking.status,
      raw_booking_json: booking.raw_booking_json,
    })
    .select()
    .single();

  if (error) {
    console.error('[BOOKING] Error inserting booking:', error);
    return { ok: false, error: 'DB_ERROR', details: error };
  }

  const bookingRecord = data;
  console.log('[BOOKING] Created booking record:', bookingRecord.id);

  // Create calendar event
  try {
    const event = await createCalendarEvent(
      {
        ...booking,
        service: booking.service_slug,
      },
      settings
    );

    if (event && event.id) {
      // Update booking with calendar_event_id
      await supabase
        .from('bookings')
        .update({ calendar_event_id: event.id })
        .eq('id', bookingRecord.id);

      console.log('[BOOKING] Created calendar event:', event.id);
      return { ok: true, bookingId: bookingRecord.id, calendarEventId: event.id };
    }

    console.warn('[BOOKING] Calendar event creation returned null - booking saved but calendar sync skipped');
    return { ok: true, bookingId: bookingRecord.id, calendarEventId: null };
  } catch (err) {
    console.error('[BOOKING] Failed to create calendar event:', {
      message: err.message,
      code: err.code,
    });

    // Booking is already saved, but no calendar event
    return {
      ok: true,
      bookingId: bookingRecord.id,
      calendarEventId: null,
      calendarError: err,
    };
  }
}

/**
 * Cancels a booking.
 * @param {string} tenantId - Business ID (UUID)
 * @param {Object} intent - { client_phone, date?, time? }
 * @returns {Promise<{cancelled: boolean, booking?: Object, reason?: string}>}
 */
export async function cancelBooking(tenantId, intent) {
  if (!tenantId || !intent || !intent.client_phone) {
    return { cancelled: false, reason: 'MISSING_PARAMS' };
  }

  // Build query
  let query = supabase
    .from('bookings')
    .select('*')
    .eq('business_id', tenantId)
    .eq('client_phone', intent.client_phone)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(1);

  // Filter by date if provided
  if (intent.date) {
    query = query.eq('date', intent.date);
  }

  // Filter by time if provided
  if (intent.time) {
    query = query.eq('time', intent.time);
  }

  const { data: bookings, error } = await query;

  if (error) {
    console.error('[BOOKING] Error querying bookings for cancellation:', error);
    return { cancelled: false, reason: 'QUERY_ERROR' };
  }

  if (!bookings || bookings.length === 0) {
    console.log('[BOOKING] No confirmed booking found to cancel');
    return { cancelled: false, reason: 'NOT_FOUND' };
  }

  const booking = bookings[0];

  // Cancel calendar event if exists
  // Note: cancelBooking would need settings parameter - for now using null (will fall back to env)
  if (booking.calendar_event_id) {
    try {
      await cancelCalendarEvent(booking.calendar_event_id, null);
      console.log('[BOOKING] Cancelled calendar event:', booking.calendar_event_id);
    } catch (calendarError) {
      console.error('[BOOKING] Error cancelling calendar event:', calendarError.message);
      // Continue with DB update even if calendar cancel fails
    }
  }

  // Update booking status
  const { data: updatedBooking, error: updateError } = await supabase
    .from('bookings')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', booking.id)
    .select()
    .single();

  if (updateError) {
    console.error('[BOOKING] Error updating booking status:', updateError);
    return { cancelled: false, reason: 'UPDATE_ERROR' };
  }

  console.log('[BOOKING] Cancelled booking:', booking.id);
  return { cancelled: true, booking: updatedBooking };
}

/**
 * Reschedules a booking.
 * @param {string} tenantId - Business ID (UUID)
 * @param {Object} intent - { client_phone, old_date?, old_time?, new_date, new_time }
 * @returns {Promise<{rescheduled: boolean, booking?: Object, calendarEvent?: Object, reason?: string}>}
 */
export async function rescheduleBooking(tenantId, intent) {
  if (!tenantId || !intent || !intent.client_phone || !intent.new_date || !intent.new_time) {
    return { rescheduled: false, reason: 'MISSING_PARAMS' };
  }

  // Build query to find existing booking
  let query = supabase
    .from('bookings')
    .select('*')
    .eq('business_id', tenantId)
    .eq('client_phone', intent.client_phone)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(1);

  // Filter by old_date if provided
  if (intent.old_date) {
    query = query.eq('date', intent.old_date);
  }

  // Filter by old_time if provided
  if (intent.old_time) {
    query = query.eq('time', intent.old_time);
  }

  const { data: bookings, error } = await query;

  if (error) {
    console.error('[BOOKING] Error querying bookings for reschedule:', error);
    return { rescheduled: false, reason: 'QUERY_ERROR' };
  }

  if (!bookings || bookings.length === 0) {
    console.log('[BOOKING] No confirmed booking found to reschedule');
    return { rescheduled: false, reason: 'NOT_FOUND' };
  }

  const booking = bookings[0];

  // Reschedule calendar event if exists
  // Note: rescheduleBooking would need settings parameter - for now using null (will fall back to env)
  let calendarEvent = null;
  if (booking.calendar_event_id) {
    try {
      calendarEvent = await rescheduleCalendarEvent(
        booking.calendar_event_id,
        intent.new_date,
        intent.new_time,
        booking.duration_minutes,
        null
      );
      console.log('[BOOKING] Rescheduled calendar event:', booking.calendar_event_id);
    } catch (calendarError) {
      console.error('[BOOKING] Error rescheduling calendar event:', calendarError.message);
      // Continue with DB update even if calendar reschedule fails
    }
  }

  // Update booking date/time
  const { data: updatedBooking, error: updateError } = await supabase
    .from('bookings')
    .update({
      date: intent.new_date,
      time: intent.new_time,
      updated_at: new Date().toISOString()
    })
    .eq('id', booking.id)
    .select()
    .single();

  if (updateError) {
    console.error('[BOOKING] Error updating booking date/time:', updateError);
    return { rescheduled: false, reason: 'UPDATE_ERROR' };
  }

  console.log('[BOOKING] Rescheduled booking:', booking.id);
  return { rescheduled: true, booking: updatedBooking, calendarEvent };
}

