-- Migration: Add is_bookable column to services table
-- This allows marking up to 8 services as available for online booking

ALTER TABLE services
ADD COLUMN IF NOT EXISTS is_bookable BOOLEAN NOT NULL DEFAULT FALSE;

-- Create index for faster queries when filtering bookable services
CREATE INDEX IF NOT EXISTS idx_services_is_bookable ON services(business_id, is_bookable) WHERE is_bookable = true;










