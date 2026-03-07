const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { getAvailableSlots, createCalendarEvent } = require('../services/google-calendar');
const { sendBookingConfirmation } = require('../services/email');

// GET /api/book/:token — fetch booking request details for the client page
// Client-facing: no authentication required
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  const { data: request, error } = await supabase
    .from('booking_requests')
    .select('id, client_name, duration_hours, notes, status, expires_at, artists(name, display_name, deposit_enabled, deposit_amount, deposit_links, deposit_description, deposit_fine_print, booking_days_ahead)')
    .eq('token', token)
    .single();

  if (error || !request) return res.status(404).json({ error: 'This booking link is not valid.' });

  const now = new Date();
  const artist = request.artists;

  // If already booked, include appointment time and deposit info for revisit
  if (request.status === 'booked') {
    const { data: booking } = await supabase
      .from('bookings')
      .select('start_time, end_time')
      .eq('request_id', request.id)
      .single();

    // Expire 1 week after the appointment ends
    if (booking && new Date(booking.end_time).getTime() + 7 * 24 * 60 * 60 * 1000 < now.getTime()) {
      return res.status(410).json({ error: 'This booking link has expired.' });
    }

    const deposit = artist?.deposit_enabled ? {
      amount:      artist.deposit_amount,
      links:       artist.deposit_links        || [],
      description: artist.deposit_description  || null,
      fine_print:  artist.deposit_fine_print   || null,
    } : null;

    return res.json({
      client_name:    request.client_name,
      duration_hours: request.duration_hours,
      status:         request.status,
      artist_name:    artist?.display_name || artist?.name || null,
      start_time:     booking?.start_time,
      end_time:       booking?.end_time,
      deposit,
    });
  }

  // Pending link — use the original expiry
  if (request.expires_at && new Date(request.expires_at) < now) {
    return res.status(410).json({ error: 'This booking link has expired.' });
  }

  res.json({
    client_name:        request.client_name,
    duration_hours:     request.duration_hours,
    notes:              request.notes,
    status:             request.status,
    expires_at:         request.expires_at,
    artist_name:        artist?.display_name || artist?.name || null,
    booking_days_ahead: artist?.booking_days_ahead ?? 30,
  });
});

// GET /api/book/:token/availability — available slots for the request's duration
// Client-facing: no authentication required
router.get('/:token/availability', async (req, res) => {
  const { token } = req.params;
  const daysAhead = parseInt(req.query.days) || 30;

  const { data: request, error } = await supabase
    .from('booking_requests')
    .select('*, artists(google_refresh_token, google_calendar_id, work_start_hour, work_end_hour, days_off, buffer_minutes)')
    .eq('token', token)
    .single();

  if (error || !request) return res.status(404).json({ error: 'Booking request not found' });
  if (request.status === 'booked') return res.status(409).json({ error: 'This slot has already been booked' });
  if (request.expires_at && new Date(request.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This booking link has expired' });
  }

  const artist = request.artists;
  if (!artist?.google_refresh_token) {
    return res.status(503).json({ error: 'Artist has not connected their Google Calendar yet.' });
  }

  try {
    const slots = await getAvailableSlots(
      request.duration_hours,
      daysAhead,
      { refreshToken: artist.google_refresh_token, calendarId: artist.google_calendar_id },
      {
        work_start_hour: artist.work_start_hour ?? 9,
        work_end_hour:   artist.work_end_hour   ?? 21,
        days_off:        artist.days_off        ?? [],
        buffer_minutes:  artist.buffer_minutes  ?? 0,
      }
    );
    res.json({ slots, duration_hours: request.duration_hours, days_off: artist.days_off ?? [] });
  } catch (err) {
    console.error('Calendar availability error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar availability.' });
  }
});

// POST /api/book/:token — client confirms a slot
// Client-facing: no authentication required
router.post('/:token', async (req, res) => {
  const { token } = req.params;
  const { start_time, client_email } = req.body;

  if (!start_time) return res.status(400).json({ error: 'start_time is required' });

  const { data: request, error } = await supabase
    .from('booking_requests')
    .select('*, artists(google_refresh_token, google_calendar_id, email, deposit_enabled, deposit_amount, deposit_links, deposit_description, deposit_fine_print)')
    .eq('token', token)
    .single();

  if (error || !request) return res.status(404).json({ error: 'Booking request not found' });
  if (request.status === 'booked') return res.status(409).json({ error: 'This appointment has already been booked' });
  if (request.expires_at && new Date(request.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This booking link has expired' });
  }

  const artist = request.artists;
  if (!artist?.google_refresh_token) {
    return res.status(503).json({ error: 'Artist has not connected their Google Calendar.' });
  }

  const startTime = new Date(start_time);
  const endTime = new Date(startTime.getTime() + request.duration_hours * 60 * 60 * 1000);
  const artistTokens = {
    refreshToken: artist.google_refresh_token,
    calendarId: artist.google_calendar_id,
  };

  // Create Google Calendar event
  let googleEvent;
  try {
    googleEvent = await createCalendarEvent({
      clientName: request.client_name,
      clientEmail: client_email || null,
      artistEmail: artist.email || null,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      notes: request.notes,
      artistTokens,
    });
  } catch (err) {
    console.error('Calendar event creation failed:', err.message);
    return res.status(500).json({ error: 'Failed to create calendar event.' });
  }

  // Save booking to DB
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert({
      request_id: request.id,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      google_event_id: googleEvent.id,
      client_email: client_email || null,
    })
    .select()
    .single();

  if (bookingError) {
    console.error('DB booking error:', bookingError.message);
    return res.status(500).json({ error: 'Booking created on calendar but failed to save to database.' });
  }

  // Mark request as booked
  await supabase
    .from('booking_requests')
    .update({ status: 'booked' })
    .eq('id', request.id);

  // Fire-and-forget email notification to artist
  sendBookingConfirmation({
    artistEmail: artist.email,
    clientName: request.client_name,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    notes: request.notes,
  }).catch(() => {}); // already logged inside, don't block

  const deposit = artist.deposit_enabled ? {
    amount:      artist.deposit_amount,
    links:       artist.deposit_links        || [],
    description: artist.deposit_description  || null,
    fine_print:  artist.deposit_fine_print   || null,
  } : null;

  res.status(201).json({
    success: true,
    booking_id: booking.id,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    client_name: request.client_name,
    deposit,
  });
});

module.exports = router;
