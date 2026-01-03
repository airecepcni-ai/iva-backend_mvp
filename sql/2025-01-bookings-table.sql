-- Apply in Supabase SQL editor
-- Migration: Create bookings table for IVA appointment lifecycle

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  calendar_event_id text,
  client_name text not null,
  client_phone text not null,
  client_email text,
  service_slug text not null,
  location text not null,
  date date not null,
  time time not null,
  duration_minutes integer not null,
  status text not null default 'confirmed',
  raw_booking_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_business_id_idx on bookings (business_id);
create index if not exists bookings_client_phone_idx on bookings (client_phone);
create index if not exists bookings_calendar_event_id_idx on bookings (calendar_event_id);

-- Add RLS policies (adjust as needed for your auth setup)
alter table bookings enable row level security;

-- Policy: Users can view bookings for their businesses
create policy "Users can view own business bookings" on bookings
  for select using (
    exists (
      select 1 from businesses 
      where businesses.id = bookings.business_id 
      and businesses.owner_id = auth.uid()
    )
  );

-- Policy: Service role can manage all bookings (for backend)
create policy "Service role can manage all bookings" on bookings
  for all using (true);














