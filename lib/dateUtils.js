// iva-backend/lib/dateUtils.js
import { DateTime } from 'luxon';

/**
 * Convert Czech relative date expressions like "zítra" to ISO YYYY-MM-DD.
 * If the input is already ISO (YYYY-MM-DD), it is returned as is.
 * Returns null if parsing fails.
 */
export function parseRelativeDate(input) {
  if (!input) return null;
  const lower = String(input).trim().toLowerCase();

  // Already ISO date?
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) {
    return lower;
  }

  const now = DateTime.local().setZone('Europe/Prague');

  if (lower === 'dnes') {
    return now.toISODate();
  }

  if (lower === 'zítra' || lower === 'zitra') {
    return now.plus({ days: 1 }).toISODate();
  }

  if (lower === 'pozítří' || lower === 'pozitri') {
    return now.plus({ days: 2 }).toISODate();
  }

  // Try generic ISO parsing (e.g. "2025-11-24")
  const asIso = DateTime.fromISO(input);
  if (asIso.isValid) {
    return asIso.toISODate();
  }

  // Fallback: try European-style "24.11.2025"
  const dotMatch = lower.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const [_, d, m, y] = dotMatch;
    const dt = DateTime.fromObject({
      day: Number(d),
      month: Number(m),
      year: Number(y),
    }, { zone: 'Europe/Prague' });
    if (dt.isValid) return dt.toISODate();
  }

  return null;
}

/**
 * Combine date (YYYY-MM-DD or relative) and time (HH:MM) into Luxon DateTime.
 * Returns null if invalid.
 */
export function combineDateTime(date, time) {
  const isoDate = parseRelativeDate(date);
  if (!isoDate || !time) return null;

  const [h, m] = String(time).split(':').map(Number);
  const dt = DateTime.fromObject({
    year: Number(isoDate.slice(0, 4)),
    month: Number(isoDate.slice(5, 7)),
    day: Number(isoDate.slice(8, 10)),
    hour: h,
    minute: m,
  }, { zone: 'Europe/Prague' });

  return dt.isValid ? dt : null;
}














