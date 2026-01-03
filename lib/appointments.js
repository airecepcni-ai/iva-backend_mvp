import { supabase } from './supabaseClient.js';
import { getIvaSettingsForTenant } from './chatHandler.js';
import { createBooking } from './bookingService.js';
import { parseRelativeDate } from './dateUtils.js';
import { cancelCalendarEvent, rescheduleCalendarEvent, isSlotAvailable } from './googleCalendar.js';
import { DateTime } from 'luxon';

/**
 * Shared function to handle booking updates (cancel or reschedule)
 * Used by both VAPI and Dashboard routes
 * 
 * @param {Object} params
 * @param {string} params.bookingId - Booking ID (UUID)
 * @param {string} params.action - 'cancel' or 'reschedule'
 * @param {string} params.businessId - Business ID (UUID)
 * @param {string} [params.date] - New date for reschedule (YYYY-MM-DD)
 * @param {string} [params.time] - New time for reschedule (HH:mm)
 * @returns {Promise<{success: boolean, error?: string, message_cs?: string}>}
 */
export async function handleUpdateAppointment({ bookingId, action, businessId, date, time }) {
  try {
    // Validate required fields
    if (!bookingId) {
      return {
        success: false,
        error: 'MISSING_APPOINTMENT_ID',
        message_cs: 'Potřebuji ID rezervace, abych s ní mohla pracovat.',
      };
    }

    if (!action || (action !== 'cancel' && action !== 'reschedule')) {
      return {
        success: false,
        error: 'INVALID_ACTION',
        message_cs: 'Řekněte mi prosím, zda chcete rezervaci zrušit nebo přesunout.',
      };
    }

    if (!businessId) {
      return {
        success: false,
        error: 'CONFIG_ERROR',
        message_cs: 'Omlouvám se, ale systém pro práci s rezervacemi není správně nastavený.',
      };
    }

    // Load IVA settings (needed for Google Calendar integration)
    const { settings, error: settingsError } = await getIvaSettingsForTenant(businessId);
    if (settingsError) {
      console.error('[APPOINTMENTS] Failed to load settings:', settingsError);
      // Continue anyway - booking can still be updated in DB
    }

    // Load the booking by id + business_id
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .eq('business_id', businessId)
      .single();

    if (bookingError || !booking) {
      console.error('[APPOINTMENTS] Booking not found:', bookingError);
      return {
        success: false,
        error: 'BOOKING_NOT_FOUND',
        message_cs: 'Omlouvám se, tuto rezervaci jsem v systému nenašla.',
      };
    }

    // Handle cancel action
    if (action === 'cancel') {
      // Update booking status to cancelled
      const { error: updateError } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', bookingId);

      if (updateError) {
        console.error('[APPOINTMENTS] Error updating booking status:', updateError);
        return {
          success: false,
          error: 'UPDATE_FAILED',
          message_cs: 'Omlouvám se, zrušení rezervace se nepodařilo dokončit.',
        };
      }

      // Delete calendar event if exists (log errors but don't fail the request)
      if (booking.calendar_event_id) {
        try {
          await cancelCalendarEvent(booking.calendar_event_id, settings);
          console.log('[APPOINTMENTS] Cancelled calendar event:', booking.calendar_event_id);
        } catch (calendarError) {
          console.error('[APPOINTMENTS] Error cancelling calendar event:', calendarError);
          // Continue - calendar error should not fail the entire request
        }
      }

      console.log('[APPOINTMENTS] Cancelled booking:', bookingId);
      return {
        success: true,
        message_cs: 'Rezervace byla úspěšně zrušena.',
      };
    }

    // Handle reschedule action
    if (action === 'reschedule') {
      // Validate: reschedule requires both date and time
      if (!date || !time) {
        return {
          success: false,
          error: 'MISSING_NEW_TIME',
          message_cs: 'Pro změnu termínu potřebuji nový den a čas.',
        };
      }

      // Resolve date - for dashboard, date is already in YYYY-MM-DD format
      // parseRelativeDate handles ISO dates and relative dates like "zítra"
      const resolvedDate = parseRelativeDate(date);
      if (!resolvedDate) {
        return {
          success: false,
          error: 'INVALID_DATE',
          message_cs: 'Systém nerozumí zadanému datu. Prosím zadejte platné datum ve formátu YYYY-MM-DD.',
        };
      }

      // Validate that resolved date is not in the past
      const today = DateTime.local().setZone('Europe/Prague').startOf('day');
      const resolvedDt = DateTime.fromISO(resolvedDate).setZone('Europe/Prague').startOf('day');
      
      if (!resolvedDt.isValid) {
        console.warn('[APPOINTMENTS] Invalid resolved date:', resolvedDate);
        return {
          success: false,
          error: 'INVALID_DATE',
          message_cs: 'Systém nerozumí zadanému datu. Zkuste ho prosím říct třeba jako „8. 12. 2025" nebo „příští pondělí".',
        };
      }

      if (resolvedDt < today) {
        console.warn('[APPOINTMENTS] Warning: resolved date is in the past', { resolvedDate, today: today.toISODate() });
        return {
          success: false,
          error: 'PAST_DATE',
          message_cs: 'Omlouvám se, ale tenhle termín je podle systému už v minulosti. Zkusme prosím vybrat nějaký jiný, budoucí termín.',
        };
      }

      // Normalize time (ensure HH:mm format)
      const normalizedTime = String(time).trim();
      if (!/^\d{1,2}:\d{2}$/.test(normalizedTime)) {
        return {
          success: false,
          error: 'INVALID_TIME',
          message_cs: 'Omlouvám se, čas musí být ve formátu HH:MM, například "14:30".',
        };
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
        return {
          success: false,
          error: 'TIME_NOT_AVAILABLE',
          message_cs: 'V tomto termínu už je plno. Zkuste prosím jiný čas.',
        };
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
        .eq('id', bookingId);

      if (updateError) {
        console.error('[APPOINTMENTS] Error updating booking date/time:', updateError);
        return {
          success: false,
          error: 'UPDATE_FAILED',
          message_cs: 'Omlouvám se, změnu rezervace se nepodařilo dokončit.',
        };
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
          console.log('[APPOINTMENTS] Rescheduled calendar event:', booking.calendar_event_id);
        } catch (calendarError) {
          console.error('[APPOINTMENTS] Error rescheduling calendar event:', calendarError);
          // Continue - calendar error should not fail the entire request
        }
      }

      console.log('[APPOINTMENTS] Rescheduled booking:', bookingId);
      return {
        success: true,
        message_cs: `Rezervaci jsem přesunula na ${resolvedDate} v ${normalizedTime}.`,
      };
    }
  } catch (err) {
    console.error('[APPOINTMENTS] handleUpdateAppointment error', err);
    return {
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, při práci s rezervací se něco pokazilo. Zkuste to prosím za chvíli znovu.',
    };
  }
}

/**
 * Shared function to handle booking creation
 * Used by both VAPI and dashboard routes
 * 
 * @param {Object} params
 * @param {string} params.businessId - Business ID (UUID)
 * @param {string} params.serviceName - Service name/slug
 * @param {string} params.date - Date (YYYY-MM-DD)
 * @param {string} params.time - Time (HH:mm)
 * @param {string} params.customerName - Customer name
 * @param {string} params.customerPhone - Customer phone
 * @param {string} [params.locationName] - Location name (optional)
 * @param {string} [params.notes] - Notes (optional)
 * @param {string} [params.customerEmail] - Customer email (optional)
 * @param {number} [params.durationMinutes] - Duration in minutes (optional)
 * @returns {Promise<{success: boolean, error?: string, message_cs?: string, bookingId?: string, calendarEventId?: string}>}
 */
export async function handleBookAppointment({
  businessId,
  serviceName,
  date,
  time,
  customerName,
  customerPhone,
  locationName = '',
  notes = '',
  customerEmail = null,
  durationMinutes = null,
}) {
  try {
    // Validate required fields
    if (!businessId) {
      return {
        success: false,
        error: 'MISSING_BUSINESS_ID',
        message_cs: 'Chybí identifikátor firmy. Zkuste se znovu přihlásit.',
      };
    }

    if (!serviceName || !date || !time || !customerName || !customerPhone) {
      return {
        success: false,
        error: 'MISSING_REQUIRED_FIELDS',
        message_cs: 'Omlouvám se, některé údaje o rezervaci chybí. Prosím vyplňte všechny povinné položky.',
      };
    }

    // Load IVA settings (needed for Google Calendar integration)
    const { settings, error: settingsError } = await getIvaSettingsForTenant(businessId);
    if (settingsError) {
      console.error('[APPOINTMENTS] Failed to load settings:', settingsError);
      // Continue anyway - booking can still be saved to DB
    }

    // Build bookingPayload in the format expected by createBooking
    const bookingPayload = {
      service: serviceName,
      client_name: customerName,
      client_phone: customerPhone,
      client_email: customerEmail || null,
      location: locationName || '',
      date: date, // Already in YYYY-MM-DD format from dashboard
      time: time, // Already in HH:mm format from dashboard
      duration_minutes: durationMinutes || null,
      notes: notes || '',
    };

    // Call the existing booking logic (same as IVA chat)
    const result = await createBooking(businessId, settings || {}, bookingPayload);

    if (!result.ok) {
      // Map error codes to Czech messages
      let errorMessageCs = 'Omlouvám se, rezervaci se nepodařilo vytvořit. Zkuste prosím jiný termín nebo službu.';
      
      if (result.error === 'TIME_CONFLICT') {
        errorMessageCs = 'Bohužel tento termín už je obsazený. Zkuste prosím jiný čas nebo den.';
      } else if (result.error === 'INVALID_DATE') {
        errorMessageCs = 'Omlouvám se, nerozumím přesně datu rezervace. Prosím zadejte platné datum.';
      } else if (result.error === 'INVALID_PAYLOAD') {
        errorMessageCs = 'Omlouvám se, některé údaje o rezervaci chybí. Prosím vyplňte všechny povinné položky.';
      }

      return {
        success: false,
        error: result.error || 'BOOKING_FAILED',
        message_cs: errorMessageCs,
      };
    }

    return {
      success: true,
      bookingId: result.bookingId || null,
      calendarEventId: result.calendarEventId || null,
      message_cs: 'Rezervace byla úspěšně vytvořena.',
    };
  } catch (err) {
    console.error('[APPOINTMENTS] handleBookAppointment error', err);
    return {
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, došlo k technické chybě. Zkuste to prosím za chvíli znovu.',
    };
  }
}

