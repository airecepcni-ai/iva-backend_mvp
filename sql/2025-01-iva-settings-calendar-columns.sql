-- Apply in Supabase SQL editor
-- Migration: Add Google Calendar columns to iva_settings table

-- Add calendar + refresh token columns to iva_settings if missing
alter table iva_settings
  add column if not exists google_calendar_id text,
  add column if not exists google_refresh_token text;

-- Add comment for documentation
comment on column iva_settings.google_calendar_id is 'Primary Google Calendar email/ID for this business (e.g. business@gmail.com)';
comment on column iva_settings.google_refresh_token is 'Optional per-business Google OAuth refresh token (falls back to env GOOGLE_REFRESH_TOKEN if null)';















