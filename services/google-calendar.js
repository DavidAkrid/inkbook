const { google } = require('googleapis');

// ── Eastern timezone helpers ──────────────────────────────────────────────────
// Vercel (and most Node hosts) run in UTC, so Date.setHours() / Date.getDay()
// operate in UTC, not Eastern. These helpers do all date math in ET.

/** Returns 'YYYY-MM-DD' for the Eastern calendar date of `date`. */
function etDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Returns 0–6 (Sun–Sat) for the Eastern weekday of the given ET date string. */
function etDayOfWeek(dateStr) {
  // Noon UTC is always within the same ET calendar day (ET is UTC-4 or UTC-5).
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

/** Returns the ET date string for `n` calendar days after the given ET date string. */
function addETDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return etDateStr(d);
}

/**
 * Returns a UTC Date representing hour:00:00 Eastern on the given ET date string.
 * Uses noon UTC as a DST-safe reference — DST transitions always happen at 2am,
 * never at noon, so the noon-based offset is correct for any normal work hour.
 */
function etHourToUTC(dateStr, hour) {
  const noonUTC = new Date(dateStr + 'T12:00:00Z');
  const etHourAtNoon = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
      hourCycle: 'h23',
    }).format(noonUTC)
  );
  // midnightET in UTC = noonUTC minus however many hours noon is past midnight in ET
  const midnightET = new Date(noonUTC.getTime() - etHourAtNoon * 60 * 60 * 1000);
  return new Date(midnightET.getTime() + hour * 60 * 60 * 1000);
}

function buildOAuthClient(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );
  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }
  return oauth2Client;
}

/** Generate the Google Calendar OAuth consent URL. */
function getCalendarAuthUrl(state) {
  const oauth2Client = buildOAuthClient(null);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

/** Exchange an auth code for tokens. Returns { access_token, refresh_token, ... } */
async function exchangeCodeForTokens(code) {
  const oauth2Client = buildOAuthClient(null);
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/**
 * Find available time slots for a given duration.
 * @param {number} durationHours
 * @param {number} daysAhead
 * @param {{ refreshToken: string, calendarId: string }} artistTokens
 * @param {{ work_start_hour?: number, work_end_hour?: number, days_off?: number[], buffer_minutes?: number }} settings
 */
async function getAvailableSlots(durationHours, daysAhead = 30, artistTokens, settings = {}, startFromToday = false) {
  const auth = buildOAuthClient(artistTokens.refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = artistTokens.calendarId;

  const workStart = settings.work_start_hour ?? 9;
  const workEnd   = settings.work_end_hour   ?? 21;
  const daysOff   = settings.days_off        ?? [];
  const bufferMs  = (settings.buffer_minutes ?? 0) * 60 * 1000;

  const now        = new Date();
  const durationMs     = durationHours * 60 * 60 * 1000;
  const checkMs        = durationMs + bufferMs; // includes buffer for overlap detection
  const slotIntervalMs = 30 * 60 * 1000;

  // Work with ET calendar date strings so work hours are always Eastern, not UTC.
  const todayET    = etDateStr(now);
  const firstDayET = startFromToday ? todayET : addETDays(todayET, 1);
  const lastDayET  = addETDays(todayET, daysAhead);

  const timeMin = etHourToUTC(firstDayET, workStart);
  const timeMax = etHourToUTC(lastDayET, workEnd);

  const freebusyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busyPeriods = freebusyRes.data.calendars[calendarId]?.busy || [];

  const slots = [];
  let curDayET = firstDayET;

  while (curDayET <= lastDayET) {
    // Skip days off (0=Sun … 6=Sat), checked in ET so the weekday is correct
    if (!daysOff.includes(etDayOfWeek(curDayET))) {
      const dayStart = etHourToUTC(curDayET, workStart);
      const dayEnd   = etHourToUTC(curDayET, workEnd);
      let slotStart  = new Date(dayStart);

      while (slotStart.getTime() + durationMs <= dayEnd.getTime()) {
        const slotEnd   = new Date(slotStart.getTime() + durationMs);
        const slotEnd30 = new Date(slotStart.getTime() + slotIntervalMs); // 30-min window
        const checkEnd  = new Date(slotStart.getTime() + checkMs);        // duration + buffer

        // Is the artist's own 30-min window occupied by an event?
        const directlyBusy = busyPeriods.some((busy) => {
          const busyStart = new Date(busy.start);
          const busyEnd   = new Date(busy.end);
          return slotStart < busyEnd && slotEnd30 > busyStart;
        });

        // Is the 30-min window free but the full appointment (+ buffer) would overlap?
        const durationOverlaps = !directlyBusy && busyPeriods.some((busy) => {
          const busyStart = new Date(busy.start);
          const busyEnd   = new Date(busy.end);
          return slotStart < busyEnd && checkEnd > busyStart;
        });

        const type = directlyBusy ? 'busy' : durationOverlaps ? 'overlap' : 'available';

        slots.push({
          start:     slotStart.toISOString(),
          end:       slotEnd.toISOString(),
          available: type === 'available',
          type,
        });

        slotStart = new Date(slotStart.getTime() + slotIntervalMs);
      }
    }

    curDayET = addETDays(curDayET, 1);
  }

  return slots;
}

/**
 * Create a Google Calendar event on the artist's calendar.
 * @param {{ clientName, clientEmail, startTime, endTime, notes, imageUrl, artistTokens: { refreshToken, calendarId } }} params
 */
async function createCalendarEvent({ clientName, clientEmail, artistEmail, startTime, endTime, notes, artistTokens }) {
  const auth = buildOAuthClient(artistTokens.refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = artistTokens.calendarId;

  let description = `Client: ${clientName}\n`;
  if (notes) description += `\nDesign Notes:\n${notes}`;

  const attendees = [];
  if (artistEmail) attendees.push({ email: artistEmail });
  if (clientEmail) attendees.push({ email: clientEmail });

  const event = {
    summary: clientName,
    description,
    start: { dateTime: startTime, timeZone: 'America/New_York' },
    end: { dateTime: endTime, timeZone: 'America/New_York' },
    attendees,
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 60 },
      ],
    },
  };

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
    sendUpdates: clientEmail ? 'all' : 'none',
  });

  return res.data;
}

/**
 * Fetch calendar events with their titles (for artist reference view).
 * Uses events.list instead of freebusy so we get summaries.
 */
async function getCalendarEventTitles(daysAhead, artistTokens, startFromToday = false) {
  const auth = buildOAuthClient(artistTokens.refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });

  const now        = new Date();
  const todayET    = etDateStr(now);
  const firstDayET = startFromToday ? todayET : addETDays(todayET, 1);
  const lastDayET  = addETDays(todayET, daysAhead);

  // Start of first ET day → start of the day after the last ET day (exclusive)
  const timeMin = etHourToUTC(firstDayET, 0);
  const timeMax = etHourToUTC(addETDays(lastDayET, 1), 0);

  const res = await calendar.events.list({
    calendarId: artistTokens.calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items || []).map(e => ({
    title: e.summary || 'Event',
    // All-day events have .date instead of .dateTime — expand to full day
    start: e.start.dateTime || (e.start.date + 'T00:00:00'),
    end:   e.end.dateTime   || (e.end.date   + 'T23:59:59'),
  }));
}

module.exports = {
  getCalendarAuthUrl,
  exchangeCodeForTokens,
  getAvailableSlots,
  getCalendarEventTitles,
  createCalendarEvent,
};
