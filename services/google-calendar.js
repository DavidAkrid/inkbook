const { google } = require('googleapis');

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
async function getAvailableSlots(durationHours, daysAhead = 30, artistTokens, settings = {}) {
  const auth = buildOAuthClient(artistTokens.refreshToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = artistTokens.calendarId;

  const workStart = settings.work_start_hour ?? 9;
  const workEnd   = settings.work_end_hour   ?? 21;
  const daysOff   = settings.days_off        ?? [];
  const bufferMs  = (settings.buffer_minutes ?? 0) * 60 * 1000;

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setDate(timeMin.getDate() + 1);
  timeMin.setHours(workStart, 0, 0, 0);

  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + daysAhead);
  timeMax.setHours(workEnd, 0, 0, 0);

  const freebusyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busyPeriods = freebusyRes.data.calendars[calendarId]?.busy || [];

  const durationMs = durationHours * 60 * 60 * 1000;
  const checkMs    = durationMs + bufferMs; // includes buffer for overlap detection
  const slotIntervalMs = 30 * 60 * 1000;

  const slots = [];
  const cursor = new Date(timeMin);

  while (cursor < timeMax) {
    // Skip days off (0=Sun … 6=Sat)
    if (daysOff.includes(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(workStart, 0, 0, 0);
      continue;
    }

    const dayStart = new Date(cursor);
    dayStart.setHours(workStart, 0, 0, 0);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(workEnd, 0, 0, 0);

    let slotStart = new Date(Math.max(cursor.getTime(), dayStart.getTime()));

    while (slotStart.getTime() + durationMs <= dayEnd.getTime()) {
      const slotEnd     = new Date(slotStart.getTime() + durationMs);
      const slotEnd30   = new Date(slotStart.getTime() + slotIntervalMs); // 30-min window
      const checkEnd    = new Date(slotStart.getTime() + checkMs);        // duration + buffer

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

    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(workStart, 0, 0, 0);
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
    summary: `BOOKING — ${clientName}`,
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

module.exports = {
  getCalendarAuthUrl,
  exchangeCodeForTokens,
  getAvailableSlots,
  createCalendarEvent,
};
