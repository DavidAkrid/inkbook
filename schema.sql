-- ============================================================
-- Tattoo Booking — Full Schema
-- Run this in Supabase: Dashboard > SQL Editor > New query
-- ============================================================

-- 1. Artists — one row per signed-up user, linked to Supabase auth
CREATE TABLE artists (
  id                   UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name                 TEXT,
  email                TEXT,
  google_refresh_token TEXT,        -- NULL until they connect Google Calendar
  google_calendar_id   TEXT,        -- usually their Gmail address
  work_start_hour      SMALLINT NOT NULL DEFAULT 9,
  work_end_hour        SMALLINT NOT NULL DEFAULT 21,
  days_off             INTEGER[] NOT NULL DEFAULT '{}',  -- 0=Sun, 1=Mon … 6=Sat
  buffer_minutes       SMALLINT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Note: artist profile rows are created lazily on first API call (GET /api/requests/profile),
-- not via a DB trigger, to avoid interfering with Supabase Auth user creation.

-- 3. Booking requests — one per client the artist wants to invite to book
CREATE TABLE booking_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id      UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  token          TEXT UNIQUE NOT NULL,
  client_name    TEXT NOT NULL,
  duration_hours NUMERIC NOT NULL,
  notes          TEXT,
  image_url      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | booked
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ
);

-- 4. Bookings — confirmed appointments
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  google_event_id TEXT,
  client_email    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Auth nonces — short-lived tokens for Google Calendar OAuth callback
--    Created when artist starts the calendar connect flow, deleted after use
CREATE TABLE auth_nonces (
  nonce      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
);

-- ============================================================
-- Alter existing artists table (run if table already exists)
-- ============================================================
ALTER TABLE artists ADD COLUMN IF NOT EXISTS work_start_hour SMALLINT NOT NULL DEFAULT 9;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS work_end_hour   SMALLINT NOT NULL DEFAULT 21;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS days_off        INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE artists ADD COLUMN IF NOT EXISTS buffer_minutes  SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS display_name    TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS deposit_enabled     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS deposit_amount      NUMERIC;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS deposit_links       JSONB NOT NULL DEFAULT '[]';
ALTER TABLE artists ADD COLUMN IF NOT EXISTS deposit_description TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS deposit_fine_print  TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS booking_days_ahead SMALLINT NOT NULL DEFAULT 30;

-- Time blocks: fixed daily sessions clients choose between (minutes after midnight ET)
ALTER TABLE artists ADD COLUMN IF NOT EXISTS time_blocks      JSONB NOT NULL DEFAULT '[]';  -- [{start_min, end_min}]
ALTER TABLE artists ADD COLUMN IF NOT EXISTS time_blocks_mode TEXT  NOT NULL DEFAULT 'off'; -- off | default_on | optional
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS use_time_blocks BOOLEAN NOT NULL DEFAULT false;

-- Appearance: the artist's look on their dashboard and their clients' booking pages
ALTER TABLE artists ADD COLUMN IF NOT EXISTS theme        TEXT    NOT NULL DEFAULT 'classic'; -- classic | terminal-green | terminal-amber | terminal-purple | sunset
ALTER TABLE artists ADD COLUMN IF NOT EXISTS scanlines    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS glow         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS heading_font TEXT    NOT NULL DEFAULT 'default'; -- default | mono | serif | gothic

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_booking_requests_token    ON booking_requests(token);
CREATE INDEX idx_booking_requests_artist   ON booking_requests(artist_id);
CREATE INDEX idx_auth_nonces_expires       ON auth_nonces(expires_at);

-- ============================================================
-- Row Level Security (defense-in-depth)
-- The server uses the service role key which bypasses RLS.
-- These policies protect against any direct client-side Supabase queries.
-- ============================================================
ALTER TABLE artists          ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_nonces      ENABLE ROW LEVEL SECURITY;

-- Artists can only read/write their own profile
CREATE POLICY "artists_own_profile"
  ON artists FOR ALL
  USING (id = auth.uid());

-- Artists can only read/write their own booking requests
CREATE POLICY "artists_own_requests"
  ON booking_requests FOR ALL
  USING (artist_id = auth.uid());

-- Artists can only see bookings for their own requests
CREATE POLICY "artists_own_bookings"
  ON bookings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM booking_requests br
      WHERE br.id = bookings.request_id
        AND br.artist_id = auth.uid()
    )
  );

-- Artists can only see their own nonces
CREATE POLICY "own_nonces"
  ON auth_nonces FOR ALL
  USING (user_id = auth.uid());
