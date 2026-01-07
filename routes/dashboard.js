import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { DateTime } from 'luxon';
import { handleUpdateAppointment, handleBookAppointment } from '../lib/appointments.js';
import { computeIsSubscribed } from '../lib/subscription.js';

const router = express.Router();

/**
 * GET /api/business_profile
 * 
 * Returns the business profile, services, opening hours for the dashboard settings page.
 * 
 * Headers:
 * - x-tenant-id: business ID (UUID) - REQUIRED
 */
router.get('/business_profile', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];

    res.set('Cache-Control', 'no-store');

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({
        error: 'MISSING_TENANT_ID',
        message_cs: 'Chybí identifikátor firmy (tenant).',
      });
    }

    console.log('[DASHBOARD] GET /api/business_profile', { tenantId });

    // Fetch business subscription state (may be missing)
    // NOTE: Some deployments don't have stripe_* columns in businesses table.
    // Only select columns we know exist.
    const { data: businessRow, error: businessError } = await supabase
      .from('businesses')
      .select('id, is_subscribed')
      .eq('id', tenantId)
      .maybeSingle();

    if (businessError) {
      console.error('[DASHBOARD] business subscription fetch error', businessError);
    }

    // Fetch business_profile
    const { data: profileData, error: profileError } = await supabase
      .from('business_profile')
      .select('*')
      .eq('business_id', tenantId)
      .maybeSingle();

    if (profileError) {
      console.error('[DASHBOARD] Error fetching business_profile:', profileError);
    }

    // Fetch services
    const { data: servicesData, error: servicesError } = await supabase
      .from('services')
      .select('*')
      .eq('business_id', tenantId)
      .order('name', { ascending: true });

    if (servicesError) {
      console.error('[DASHBOARD] Error fetching services:', servicesError);
    }

    // Fetch opening_hours
    const { data: hoursData, error: hoursError } = await supabase
      .from('opening_hours')
      .select('*')
      .eq('business_id', tenantId);

    if (hoursError) {
      console.error('[DASHBOARD] Error fetching opening_hours:', hoursError);
    }

    // Build response
    const profile = profileData ? {
      id: profileData.id,
      business_id: profileData.business_id,
      name: profileData.name || '',
      address: profileData.address || null,
      phone: profileData.phone || null,
      email: profileData.email || null,
      website_url: profileData.website_url || null,
      instagram_url: profileData.instagram_url || null,
      notes: profileData.notes || null,
    } : null;

    const services = (servicesData || []).map(s => ({
      id: s.id,
      name: s.name,
      description: s.description || null,
      duration_minutes: s.duration_minutes || null,
      price_from: s.price_from || null,
      price_to: s.price_to || null,
      is_bookable: s.is_bookable ?? false,
    }));

    const openingHours = (hoursData || []).map(h => ({
      id: h.id,
      weekday: h.weekday,
      opens_at: h.opens_at || null,
      closes_at: h.closes_at || null,
      closed: h.closed ?? false,
    }));

    return res.status(200).json({
      profile,
      services,
      openingHours,
      locations: [],
      subscription: {
        isSubscribed: computeIsSubscribed(businessRow),
        is_subscribed: businessRow?.is_subscribed === true,
        stripeStatus: null,
        stripeSubscriptionStatus: null,
        stripeCurrentPeriodEnd: null,
      },
    });
  } catch (err) {
    console.error('[DASHBOARD] GET /api/business_profile unexpected error:', err);
    return res.status(500).json({
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Nepodařilo se načíst profil podniku.',
    });
  }
});

/**
 * POST /api/business_profile
 * 
 * Updates the business profile.
 * 
 * Headers:
 * - x-tenant-id: business ID (UUID) - REQUIRED
 * 
 * Body:
 * - profile: { name?, address?, phone?, email?, website_url?, instagram_url?, notes? }
 */
router.post('/business_profile', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({
        error: 'MISSING_TENANT_ID',
        message_cs: 'Chybí identifikátor firmy (tenant).',
      });
    }

    const { profile } = req.body || {};

    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({
        error: 'MISSING_PROFILE',
        message_cs: 'Chybí data profilu.',
      });
    }

    console.log('[DASHBOARD] POST /api/business_profile', { tenantId, profile });

    // Upsert business_profile
    const { error: upsertError } = await supabase
      .from('business_profile')
      .upsert({
        business_id: tenantId,
        name: profile.name || null,
        address: profile.address || null,
        phone: profile.phone || null,
        email: profile.email || null,
        website_url: profile.website_url || null,
        instagram_url: profile.instagram_url || null,
        notes: profile.notes || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'business_id',
      });

    if (upsertError) {
      console.error('[DASHBOARD] Error upserting business_profile:', upsertError);
      return res.status(500).json({
        error: 'DB_ERROR',
        message_cs: 'Nepodařilo se uložit profil podniku.',
      });
    }

    // Also update the businesses.name if provided
    if (profile.name) {
      const { error: bizError } = await supabase
        .from('businesses')
        .update({ name: profile.name, updated_at: new Date().toISOString() })
        .eq('id', tenantId);
      
      if (bizError) {
        console.warn('[DASHBOARD] Could not update businesses.name:', bizError);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Profile saved successfully',
    });
  } catch (err) {
    console.error('[DASHBOARD] POST /api/business_profile unexpected error:', err);
    return res.status(500).json({
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Nepodařilo se uložit profil podniku.',
    });
  }
});

/**
 * GET /api/bookings
 * 
 * Returns a list of bookings for the current tenant (business).
 * 
 * Query parameters:
 * - from: start date (YYYY-MM-DD), default = today in Europe/Prague
 * - to: end date (YYYY-MM-DD), default = today + 60 days
 * - status: optional status filter (e.g. "confirmed"), if not provided, return all statuses
 * - limit: optional max number of records (default 200, hard cap 500)
 * 
 * Headers:
 * - x-tenant-id: business ID (UUID) - REQUIRED
 */
router.get('/bookings', async (req, res) => {
  try {
    // Read tenant ID from header
    const tenantId = req.headers['x-tenant-id'];

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_TENANT_ID',
        message_cs: 'Chybí identifikátor firmy (tenant). Zkuste se znovu přihlásit.',
      });
    }

    // Parse query parameters
    const today = DateTime.now().setZone('Europe/Prague').startOf('day');
    const fromDate = req.query.from?.toString() || today.toISODate();
    const toDate = req.query.to?.toString() || today.plus({ days: 60 }).toISODate();
    const statusFilter = req.query.status?.toString() || '';
    const limitParam = parseInt(req.query.limit?.toString() || '200', 10);
    const limit = Math.min(Math.max(limitParam, 1), 500); // Clamp between 1 and 500

    console.log('[DASHBOARD] GET /api/bookings', {
      tenantId,
      fromDate,
      toDate,
      statusFilter: statusFilter || 'all',
      limit,
    });

    // Build query - try with original_date first, fallback if column doesn't exist
    let query = supabase
      .from('bookings')
      .select('id, service_slug, client_name, client_phone, location, date, time, duration_minutes, status, calendar_event_id')
      .eq('business_id', tenantId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date', { ascending: true })
      .order('time', { ascending: true })
      .limit(limit);

    // Apply status filter if provided
    // For 'rescheduled' and 'all', don't filter in SQL (handled client-side for rescheduled)
    if (statusFilter && statusFilter !== 'rescheduled' && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    const { data: rows, error } = await query;

    // Handle Supabase query errors
    if (error) {
      console.error('[DASHBOARD] GET /api/bookings Supabase query error:', error);
      return res.status(200).json({
        success: false,
        error: 'DB_ERROR',
        message_cs: 'Omlouvám se, nepodařilo se mi načíst rezervace. Zkuste to prosím později.',
      });
    }

    // Map rows to response format
    const bookings = (rows || []).map(row => {
      // Normalize time: if HH:mm:ss, trim to HH:mm
      let normalizedTime = row.time || '';
      if (normalizedTime && normalizedTime.length > 5) {
        normalizedTime = normalizedTime.slice(0, 5);
      }

      // Service name logic: service_slug ?? ''
      const serviceName = row.service_slug ?? '';

      return {
        id: row.id,
        date: row.date,
        time: normalizedTime,
        serviceName: serviceName,
        customerName: row.client_name || '',
        customerPhone: row.client_phone || '',
        locationName: row.location || '',
        durationMinutes: row.duration_minutes ?? null,
        status: row.status || '',
        calendarEventId: row.calendar_event_id || null,
        originalDate: row.original_date ?? row.date ?? null,
      };
    });

    return res.status(200).json({
      success: true,
      bookings: bookings,
    });
  } catch (err) {
    console.error('[DASHBOARD] GET /api/bookings unexpected error:', err);
    return res.status(200).json({
      success: false,
      error: 'DB_ERROR',
      message_cs: 'Omlouvám se, nepodařilo se mi načíst rezervace. Zkuste to prosím později.',
    });
  }
});

/**
 * POST /api/dashboard/updateBooking
 * 
 * Updates a booking (cancel or reschedule).
 * Reuses the same logic as /api/vapi/update_appointment.
 * 
 * Body:
 * - bookingId: Booking ID (UUID) - REQUIRED
 * - action: 'cancel' or 'reschedule' - REQUIRED
 * - date: New date for reschedule (YYYY-MM-DD) - REQUIRED for reschedule
 * - time: New time for reschedule (HH:mm) - REQUIRED for reschedule
 * 
 * Headers:
 * - x-tenant-id: business ID (UUID) - REQUIRED
 */
router.post('/dashboard/updateBooking', async (req, res) => {
  try {
    const { bookingId, action, date, time } = req.body || {};

    // Read tenant ID from header
    const businessId = req.headers['x-tenant-id'];

    if (!businessId || typeof businessId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_TENANT_ID',
        message_cs: 'Chybí identifikátor firmy (tenant). Zkuste se znovu přihlásit.',
      });
    }

    if (!bookingId || !action) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_PARAMS',
        message_cs: 'Chybí ID rezervace nebo akce.',
      });
    }

    // Reuse the same logic as /api/vapi/update_appointment
    const result = await handleUpdateAppointment({
      bookingId,
      action,
      businessId,
      date,
      time,
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('[DASHBOARD] updateBooking error', err);
    return res.status(500).json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, při změně rezervace se něco pokazilo.',
    });
  }
});

/**
 * POST /api/dashboard/createBooking
 * 
 * Creates a new booking.
 * Reuses the same logic as /api/vapi/book_appointment.
 * 
 * Body:
 * - serviceName: Service name/slug - REQUIRED
 * - date: Date (YYYY-MM-DD) - REQUIRED
 * - time: Time (HH:mm) - REQUIRED
 * - customerName: Customer name - REQUIRED
 * - customerPhone: Customer phone - REQUIRED
 * - locationName: Location name (optional)
 * - notes: Notes (optional)
 * - customerEmail: Customer email (optional)
 * - durationMinutes: Duration in minutes (optional)
 * 
 * Headers:
 * - x-tenant-id: business ID (UUID) - REQUIRED
 */
router.post('/dashboard/createBooking', async (req, res) => {
  try {
    const {
      serviceName,
      date,
      time,
      customerName,
      customerPhone,
      locationName,
      notes,
      customerEmail,
      durationMinutes,
    } = req.body || {};

    // Read tenant ID from header
    const businessId = req.headers['x-tenant-id'];

    if (!businessId || typeof businessId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_TENANT_ID',
        message_cs: 'Chybí identifikátor firmy (tenant). Zkuste se znovu přihlásit.',
      });
    }

    // Basic validation
    if (!serviceName || !date || !time || !customerName || !customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_REQUIRED_FIELDS',
        message_cs: 'Omlouvám se, některé údaje o rezervaci chybí. Prosím vyplňte všechny povinné položky.',
      });
    }

    // Reuse the same logic as /api/vapi/book_appointment
    const result = await handleBookAppointment({
      businessId,
      serviceName,
      date,
      time,
      customerName,
      customerPhone,
      locationName: locationName || '',
      notes: notes || '',
      customerEmail: customerEmail || null,
      durationMinutes: durationMinutes || null,
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('[DASHBOARD] createBooking error', err);
    return res.status(500).json({
      success: false,
      error: 'UNEXPECTED_ERROR',
      message_cs: 'Omlouvám se, při vytváření rezervace se něco pokazilo.',
    });
  }
});

export default router;

