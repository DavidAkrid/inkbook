const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../services/supabase');
const authMiddleware = require('../middleware/auth');
const { getAvailableSlots, getCalendarEventTitles } = require('../services/google-calendar');
const { MODES: TIME_BLOCK_MODES, validateTimeBlocks } = require('../services/time-blocks');

// Keep in sync with public/theme.js
const THEMES = ['classic', 'terminal-green', 'terminal-amber', 'terminal-purple', 'sunset'];
const HEADING_FONTS = ['default', 'mono', 'serif', 'gothic'];

// All artist routes require authentication
router.use(authMiddleware);

// GET /api/requests/profile — artist's own profile info
// Creates the profile automatically on first sign-in if it doesn't exist yet.
router.get('/profile', async (req, res) => {
  let { data } = await supabase
    .from('artists')
    .select('id, name, email, google_calendar_id, created_at, google_refresh_token')
    .eq('id', req.user.id)
    .single();

  if (!data) {
    const { data: created, error: insertError } = await supabase
      .from('artists')
      .insert({
        id: req.user.id,
        email: req.user.email,
        name: req.user.user_metadata?.full_name || req.user.email.split('@')[0],
      })
      .select()
      .single();

    if (insertError) return res.status(500).json({ error: insertError.message });
    data = created;
  }

  res.json({
    id: data.id,
    name: data.name,
    email: data.email,
    calendar_connected: !!data.google_refresh_token,
    created_at: data.created_at,
  });
});

// GET /api/requests — list all booking requests for this artist
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('booking_requests')
    .select('*')
    .eq('artist_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/requests — create a new booking request
router.post('/', async (req, res) => {
  const { client_name, duration_hours, notes, expires_in_days, use_time_blocks } = req.body;

  if (!client_name || !duration_hours) {
    return res.status(400).json({ error: 'client_name and duration_hours are required' });
  }

  const duration = parseFloat(duration_hours);
  if (isNaN(duration) || duration <= 0 || duration > 12) {
    return res.status(400).json({ error: 'duration_hours must be between 0 and 12' });
  }

  const token = uuidv4().replace(/-/g, '').slice(0, 16);
  const expiresInDays = parseInt(expires_in_days) || 14;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  // Only honor the checkbox if the artist has time blocks turned on
  let useBlocks = false;
  if (use_time_blocks) {
    const { data: artist } = await supabase
      .from('artists')
      .select('time_blocks_mode')
      .eq('id', req.user.id)
      .single();
    useBlocks = !!artist && (artist.time_blocks_mode || 'off') !== 'off';
  }

  const { data, error } = await supabase
    .from('booking_requests')
    .insert({
      artist_id: req.user.id,
      token,
      client_name,
      duration_hours: duration,
      notes: notes || null,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
      use_time_blocks: useBlocks,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const bookingUrl = `${process.env.BASE_URL}/book/${token}`;
  res.status(201).json({ ...data, booking_url: bookingUrl });
});

// GET /api/requests/settings — fetch artist's scheduling settings
// Must be before /:token to avoid being captured by the wildcard
router.get('/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('artists')
    .select('work_start_hour, work_end_hour, days_off, buffer_minutes, display_name, deposit_enabled, deposit_amount, deposit_links, deposit_description, deposit_fine_print, booking_days_ahead, time_blocks, time_blocks_mode, theme, scanlines, glow, heading_font')
    .eq('id', req.user.id)
    .single();

  if (error || !data) {
    return res.json({ work_start_hour: 9, work_end_hour: 21, days_off: [], buffer_minutes: 0, display_name: '', deposit_enabled: false, deposit_amount: null, deposit_links: [], deposit_description: '', time_blocks: [], time_blocks_mode: 'off', theme: 'classic', scanlines: false, glow: false, heading_font: 'default' });
  }

  res.json({
    work_start_hour: data.work_start_hour ?? 9,
    work_end_hour:   data.work_end_hour   ?? 21,
    days_off:        data.days_off        ?? [],
    buffer_minutes:  data.buffer_minutes  ?? 0,
    display_name:    data.display_name    ?? '',
    deposit_enabled:     data.deposit_enabled     ?? false,
    deposit_amount:      data.deposit_amount      ?? null,
    deposit_links:       data.deposit_links       ?? [],
    deposit_description: data.deposit_description ?? '',
    deposit_fine_print:   data.deposit_fine_print  ?? '',
    booking_days_ahead:   data.booking_days_ahead  ?? 30,
    time_blocks:          data.time_blocks         ?? [],
    time_blocks_mode:     data.time_blocks_mode    ?? 'off',
    theme:                data.theme               ?? 'classic',
    scanlines:            data.scanlines           ?? false,
    glow:                 data.glow                ?? false,
    heading_font:         data.heading_font        ?? 'default',
  });
});

// POST /api/requests/settings — save artist's scheduling settings
router.post('/settings', async (req, res) => {
  const { work_start_hour, work_end_hour, days_off, buffer_minutes, display_name, deposit_enabled, deposit_amount, deposit_links, deposit_description, deposit_fine_print, booking_days_ahead, time_blocks, time_blocks_mode, theme, scanlines, glow, heading_font } = req.body;

  const start = parseInt(work_start_hour);
  const end   = parseInt(work_end_hour);
  const buf   = parseInt(buffer_minutes);

  if (isNaN(start) || start < 0 || start > 23) {
    return res.status(400).json({ error: 'work_start_hour must be 0–23' });
  }
  if (isNaN(end) || end < 0 || end > 23) {
    return res.status(400).json({ error: 'work_end_hour must be 0–23' });
  }
  if (start >= end) {
    return res.status(400).json({ error: 'work_start_hour must be before work_end_hour' });
  }
  if (isNaN(buf) || buf < 0 || buf > 120) {
    return res.status(400).json({ error: 'buffer_minutes must be 0–120' });
  }
  const daysAhead = parseInt(booking_days_ahead) || 30;
  if (daysAhead < 7 || daysAhead > 365) {
    return res.status(400).json({ error: 'booking_days_ahead must be between 7 and 365' });
  }
  if (!Array.isArray(days_off) || days_off.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    return res.status(400).json({ error: 'days_off must be an array of integers 0–6' });
  }

  // Validate deposit fields
  const depEnabled = !!deposit_enabled;
  const depAmount  = deposit_amount != null ? parseFloat(deposit_amount) : null;
  if (depEnabled && (depAmount == null || isNaN(depAmount) || depAmount < 0)) {
    return res.status(400).json({ error: 'deposit_amount must be a positive number when deposit is enabled' });
  }
  if (!Array.isArray(deposit_links) || deposit_links.some(l => !l.label || !l.url)) {
    return res.status(400).json({ error: 'deposit_links must be an array of {label, url} objects' });
  }

  // Validate time blocks
  const blocksMode = time_blocks_mode || 'off';
  if (!TIME_BLOCK_MODES.includes(blocksMode)) {
    return res.status(400).json({ error: 'time_blocks_mode must be off, default_on, or optional' });
  }
  const blockCheck = validateTimeBlocks(time_blocks ?? [], start, end);
  if (blockCheck.error) return res.status(400).json({ error: blockCheck.error });
  if (blocksMode !== 'off' && blockCheck.blocks.length === 0) {
    return res.status(400).json({ error: 'Add at least one time block, or turn time blocks off' });
  }

  // Validate appearance
  const themeVal = theme || 'classic';
  const fontVal  = heading_font || 'default';
  if (!THEMES.includes(themeVal)) return res.status(400).json({ error: 'Unknown theme' });
  if (!HEADING_FONTS.includes(fontVal)) return res.status(400).json({ error: 'Unknown heading font' });

  const { data, error } = await supabase
    .from('artists')
    .upsert({
      id: req.user.id,
      email: req.user.email,
      work_start_hour: start,
      work_end_hour: end,
      days_off,
      buffer_minutes: buf,
      display_name: (display_name || '').trim() || null,
      deposit_enabled:     depEnabled,
      deposit_amount:      depEnabled ? depAmount : null,
      deposit_links:       deposit_links,
      deposit_description: (deposit_description || '').trim() || null,
      deposit_fine_print:   (deposit_fine_print  || '').trim() || null,
      booking_days_ahead:   daysAhead,
      time_blocks:          blockCheck.blocks,
      time_blocks_mode:     blocksMode,
      theme:                themeVal,
      scanlines:            !!scanlines,
      glow:                 !!glow,
      heading_font:         fontVal,
    }, { onConflict: 'id' })
    .select('work_start_hour, work_end_hour, days_off, buffer_minutes, display_name, deposit_enabled, deposit_amount, deposit_links, deposit_description, deposit_fine_print, booking_days_ahead, time_blocks, time_blocks_mode, theme, scanlines, glow, heading_font')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/requests/availability — artist's own calendar view (reference only)
// Must be before /:token to avoid being captured by the wildcard
router.get('/availability', async (req, res) => {
  const { data: artist, error } = await supabase
    .from('artists')
    .select('google_refresh_token, google_calendar_id, work_start_hour, work_end_hour, days_off, buffer_minutes')
    .eq('id', req.user.id)
    .single();

  if (error || !artist) return res.status(404).json({ error: 'Artist profile not found.' });
  if (!artist.google_refresh_token) return res.status(503).json({ error: 'Calendar not connected.' });

  const artistTokens = {
    refreshToken: artist.google_refresh_token,
    calendarId:   artist.google_calendar_id,
  };
  const settings = {
    work_start_hour: artist.work_start_hour ?? 9,
    work_end_hour:   artist.work_end_hour   ?? 21,
    days_off:        artist.days_off        ?? [],
    buffer_minutes:  artist.buffer_minutes  ?? 0,
  };

  try {
    const [slots, events] = await Promise.all([
      getAvailableSlots(0.5, 30, artistTokens, settings, true),
      getCalendarEventTitles(30, artistTokens, true),
    ]);
    res.json({ slots, events, days_off: artist.days_off ?? [] });
  } catch (err) {
    console.error('Artist availability error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar availability.' });
  }
});

// GET /api/requests/:token — get a single booking request (used by client page too)
// Note: no auth required here — called by book.html which is unauthenticated
// We intentionally skip authMiddleware for this specific sub-path
// (handled in booking.js instead, but also accessible here for dashboard use)
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  const { data, error } = await supabase
    .from('booking_requests')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Booking request not found' });

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This booking link has expired' });
  }

  res.json(data);
});

// DELETE /api/requests/:token — artist deletes a pending request
router.delete('/:token', async (req, res) => {
  const { token } = req.params;

  // Ensure this request belongs to the authenticated artist
  const { data: existing } = await supabase
    .from('booking_requests')
    .select('id, artist_id')
    .eq('token', token)
    .single();

  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.artist_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { error } = await supabase
    .from('booking_requests')
    .delete()
    .eq('token', token);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
