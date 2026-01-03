import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { combineDateTime } from './dateUtils.js';

let envStatusLogged = false;

/**
 * Log Google Calendar environment variable status (masks secrets).
 * Can be called at startup to verify configuration.
 */
export function logGoogleCalendarEnv() {
  const hasClientId = !!process.env.GOOGLE_CLIENT_ID;
  const hasClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  const hasRefreshToken = !!process.env.GOOGLE_REFRESH_TOKEN;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || null;

  console.log('[GCAL] Env check:', {
    hasClientId,
    hasClientSecret,
    hasRefreshToken,
    calendarId,
  });
}

/**
 * Log environment variable status (masks secrets)
 * @deprecated Use logGoogleCalendarEnv() instead
 */
function logEnvStatus() {
  if (envStatusLogged) return; // Only log once
  envStatusLogged = true;
  
  console.log('[GCAL] Env check:', {
    hasClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    hasRefreshToken: !!process.env.GOOGLE_REFRESH_TOKEN,
  });
}

/**
 * Choose calendar ID in this priority:
 * 1) from settings.google_calendar_id (per tenant)
 * 2) from process.env.GOOGLE_CALENDAR_ID
 * 3) fallback: null (caller must handle)
 */
export function resolveCalendarId(settings) {
  if (settings && settings.google_calendar_id) {
    return settings.google_calendar_id;
  }
  if (process.env.GOOGLE_CALENDAR_ID) {
    return process.env.GOOGLE_CALENDAR_ID;
  }
  return null;
}

/**
 * Creates and returns an OAuth2 client for Google Calendar API.
 * Uses per-tenant refresh token if available, otherwise falls back to env var.
 * @param {Object} settings - IVA settings object (may contain google_refresh_token)
 * @returns {google.auth.OAuth2Client|null} OAuth2 client or null if env vars are missing
 */
function getOAuthClient(settings) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshTokenFromEnv = process.env.GOOGLE_REFRESH_TOKEN;
  const refreshTokenFromSettings = settings?.google_refresh_token || null;

  logEnvStatus();

  if (!clientId || !clientSecret || !(refreshTokenFromEnv || refreshTokenFromSettings)) {
    console.warn('[GCAL] Missing Google OAuth env vars / refresh token');
    return null;
  }

  // Google OAuth redirect URI - must match Google Cloud Console configuration
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:8787/oauth2callback';

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );

  oauth2Client.setCredentials({
    refresh_token: refreshTokenFromSettings || refreshTokenFromEnv,
  });

  return oauth2Client;
}

/**
 * Checks if a time slot is available in Google Calendar.
 * @param {Object} booking - Booking object with:
 *   - date: "YYYY-MM-DD" or relative date (e.g. "zítra")
 *   - time: "HH:MM"
 *   - duration_minutes: number
 * @param {Object} settings - IVA settings object (may contain google_calendar_id)
 * @returns {Promise<{ok: boolean, available: boolean, reason?: string, busy?: Array, error?: Error}>}
 */
export async function isSlotAvailable(booking, settings) {
  const oauth2Client = getOAuthClient(settings);
  const calendarId = resolveCalendarId(settings);

  if (!oauth2Client || !calendarId) {
    console.warn('[GCAL] isSlotAvailable: missing OAuth or calendarId, treating as unavailable');
    return { ok: false, available: false, reason: 'MISSING_CONFIG' };
  }

  const startDt = combineDateTime(booking.date, booking.time);
  if (!startDt) {
    console.warn('[GCAL] isSlotAvailable: invalid date/time', booking.date, booking.time);
    return { ok: false, available: false, reason: 'INVALID_DATE' };
  }

  const endDt = startDt.plus({ minutes: booking.duration_minutes || 30 });

  try {
    console.log('[GCAL] Checking availability', {
      calendarId,
      start: startDt.toISO(),
      end: endDt.toISO(),
    });

    const response = await google.calendar({ version: 'v3', auth: oauth2Client }).freebusy.query({
      requestBody: {
        timeMin: startDt.toISO(),
        timeMax: endDt.toISO(),
        items: [{ id: calendarId }],
      },
    });

    const cal = response.data.calendars?.[calendarId];
    const busy = cal?.busy || [];
    const isFree = busy.length === 0;

    console.log('[GCAL] Free/busy result', { busyCount: busy.length, isFree });

    return { ok: true, available: isFree, busy };
  } catch (err) {
    console.error('[GCAL] Error in isSlotAvailable:', {
      message: err.message,
      code: err.code,
      errors: err.errors,
    });
    return { ok: false, available: false, reason: 'API_ERROR', error: err };
  }
}

/**
 * Creates a calendar event in Google Calendar.
 * @param {Object} booking - Booking object with:
 *   - date: "YYYY-MM-DD" or relative date
 *   - time: "HH:MM"
 *   - duration_minutes: number (defaults to 60)
 *   - service_slug or service: string (service name)
 *   - client_name: string
 *   - client_phone: string
 *   - client_email?: string (optional)
 *   - location?: string (optional)
 *   - notes?: string (optional)
 * @param {Object} settings - IVA settings object (may contain google_calendar_id)
 * @returns {Promise<Object|null>} Created event data from Google Calendar API or null
 */
export async function createCalendarEvent(booking, settings) {
  const oauth2Client = getOAuthClient(settings);
  const calendarId = resolveCalendarId(settings);

  if (!oauth2Client || !calendarId) {
    console.warn('[GCAL] createCalendarEvent: missing OAuth or calendarId – skipping event creation');
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const startDt = combineDateTime(booking.date, booking.time);
  if (!startDt) {
    console.warn('[GCAL] createCalendarEvent: invalid date/time', booking.date, booking.time);
    return null;
  }

  const endDt = startDt.plus({ minutes: booking.duration_minutes || 30 });

  const event = {
    summary: `${booking.service_slug || booking.service} – ${booking.client_name}`,
    location: booking.location,
    description:
      `Phone: ${booking.client_phone}\n` +
      (booking.client_email ? `Email: ${booking.client_email}\n` : '') +
      (booking.notes || ''),
    start: {
      dateTime: startDt.toISO(),
      timeZone: 'Europe/Prague',
    },
    end: {
      dateTime: endDt.toISO(),
      timeZone: 'Europe/Prague',
    },
    attendees: booking.client_email
      ? [{ email: booking.client_email }]
      : [],
  };

  try {
    console.log('[GCAL] Creating event on calendar:', calendarId);
    const res = await calendar.events.insert({
      calendarId,
      requestBody: event,
      sendUpdates: 'all',
    });
    console.log('[GCAL] Created event', res.data.id, 'on calendar', calendarId);
    return res.data;
  } catch (err) {
    console.error('[GCAL] Error creating event:', {
      message: err.message,
      code: err.code,
      errors: err.errors,
      calendarId,
    });
    throw err;
  }
}

/**
 * Cancels/deletes a calendar event.
 * @param {string} eventId - Google Calendar event ID
 * @param {Object} settings - IVA settings object (may contain google_calendar_id)
 * @returns {Promise<void>}
 */
export async function cancelCalendarEvent(eventId, settings) {
  const oauth2Client = getOAuthClient(settings);
  const calendarId = resolveCalendarId(settings);

  if (!oauth2Client || !calendarId) {
    console.warn('[GCAL] Missing Google Calendar config – skipping event deletion');
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    console.log('[GCAL] Deleting event', eventId, 'from calendar', calendarId);
    await calendar.events.delete({
      calendarId,
      eventId
    });
    console.log('[GCAL] Deleted event', eventId, 'from calendar', calendarId);
  } catch (err) {
    console.error('[GCAL] Error deleting event:', {
      eventId,
      message: err.message,
      code: err.code,
      errors: err.errors,
      calendarId,
    });
    throw err;
  }
}

/**
 * Reschedules a calendar event to a new date/time.
 * @param {string} eventId - Google Calendar event ID
 * @param {string} newDate - New date in "YYYY-MM-DD" format or relative
 * @param {string} newTime - New time in "HH:MM" format
 * @param {number} durationMinutes - Duration in minutes (defaults to existing duration or 60)
 * @param {Object} settings - IVA settings object (may contain google_calendar_id)
 * @returns {Promise<Object>} Updated event data
 */
export async function rescheduleCalendarEvent(eventId, newDate, newTime, durationMinutes, settings) {
  const oauth2Client = getOAuthClient(settings);
  const calendarId = resolveCalendarId(settings);

  if (!oauth2Client || !calendarId) {
    console.warn('[GCAL] Missing Google Calendar config – skipping event reschedule');
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const startDt = combineDateTime(newDate, newTime);
  if (!startDt) {
    console.warn('[GCAL] rescheduleCalendarEvent: invalid date/time', newDate, newTime);
    return null;
  }

  const endDt = startDt.plus({ minutes: durationMinutes || 60 });

  try {
    console.log('[GCAL] Rescheduling event', eventId, 'on calendar', calendarId, 'to', newDate, newTime);
    const res = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        start: {
          dateTime: startDt.toISO(),
          timeZone: 'Europe/Prague'
        },
        end: {
          dateTime: endDt.toISO(),
          timeZone: 'Europe/Prague'
        }
      }
    });

    console.log('[GCAL] Rescheduled event', eventId, 'on calendar', calendarId);
    return res.data;
  } catch (err) {
    console.error('[GCAL] Error rescheduling event:', {
      eventId,
      message: err.message,
      code: err.code,
      errors: err.errors,
      calendarId,
    });
    throw err;
  }
}
