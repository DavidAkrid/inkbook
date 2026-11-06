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
 * @param {{ work_start_hour?: number, work_end_hour?: number, days_off?: number[], buffer_minutes?: number, time_blocks?: {start_min:number,end_min:number}[]|null }} settings
 *   Pass `time_blocks` only when blocks should apply to this request (see resolveTimeBlocks).
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
  const slotIntervalMs = 30 * 60 * 1000;

  // Work with ET calendar date strings so work hours are always Eastern, not UTC.
  const todayET    = etDateStr(now);
  const firstDayET = startFromToday ? todayET : addETDays(todayET, 1);
  const lastDayET  = addETDays(todayET, daysAhead);

  const timeMin = etHourToUTC(firstDayET, workStart);
  const timeMax = etHourToUTC(lastDayET, workEnd);

  // Use events.list instead of freebusy so all-day events are treated as busy
  // regardless of their "Show as: Free/Busy" setting in Google Calendar.
  // (All-day events default to "Free" when created by clicking the day header,
  // so freebusy silently skips them.)
  // Start 1ms before midnight ET so all-day events on firstDayET are included
  // (events.list timeMin is exclusive, and all-day events start at midnight ET).
  const eventsMin = new Date(etHourToUTC(firstDayET, 0).getTime() - 1);
  const eventsRes = await calendar.events.list({
    calendarId,
    timeMin: eventsMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 500,
  });
  const busyPeriods = (eventsRes.data.items || [])
    .filter(e => e.status !== 'cancelled')
    .map(e => ({
      start: e.start.dateTime || etHourToUTC(e.start.date, 0).toISOString(),
      end:   e.end.dateTime   || etHourToUTC(e.end.date,   0).toISOString(),
    }));

  return buildSlots(busyPeriods, {
    firstDayET, lastDayET, workStart, workEnd, daysOff, bufferMs, durationMs, slotIntervalMs,
    timeBlocks: settings.time_blocks || null,
  });
}

/**
 * Pure slot builder (no network) — split out so it can be tested directly.
 *
 * Buffer is applied on BOTH sides of every busy period: an appointment can't
 * start within `buffer` after an event ends, or end within `buffer` before one starts.
 *
 * Normal mode: every 30-min start within working hours, typed available/overlap/busy.
 * Time-block mode (timeBlocks = [{ start_min, end_min }], minutes after midnight ET):
 *   each block offers at most ONE start time —
 *   - the block's start, if the whole appointment fits (it may run past the block's
 *     end, but not past working hours), otherwise
 *   - the earliest free 30-min start later in the block where the appointment
 *     (+ buffer, unless the block ends at closing time) finishes by the block's end.
 *   Only offered starts are returned.
 */
function buildSlots(busyPeriods, opts) {
  const { firstDayET, lastDayET, workStart, workEnd, daysOff, bufferMs, durationMs, slotIntervalMs, timeBlocks } = opts;

  const busy = busyPeriods.map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));

  // 30-min window itself touches an event (no buffer) — used for the 'busy' display type
  const windowBusy = (s) => busy.some(b => s < b.end && s + slotIntervalMs > b.start);
  // Appointment [s, s+duration] conflicts with an event, with buffer on both sides
  const conflicts = (s) => busy.some(b => s < b.end + bufferMs && s + durationMs + bufferMs > b.start);

  const slots = [];
  let curDayET = firstDayET;

  while (curDayET <= lastDayET) {
    // Skip days off (0=Sun … 6=Sat), checked in ET so the weekday is correct
    if (!daysOff.includes(etDayOfWeek(curDayET))) {
      const dayEnd = etHourToUTC(curDayET, workEnd).getTime();

      if (timeBlocks && timeBlocks.length) {
        for (const block of timeBlocks) {
          const bStart = etHourToUTC(curDayET, block.start_min / 60).getTime();
          const bEnd   = etHourToUTC(curDayET, block.end_min / 60).getTime();
          const tailMs = bEnd < dayEnd ? bufferMs : 0;

          let offered = null;
          if (bStart + durationMs <= dayEnd && !conflicts(bStart)) {
            offered = bStart;
          } else {
            for (let s = bStart + slotIntervalMs; s + durationMs + tailMs <= bEnd; s += slotIntervalMs) {
              if (!conflicts(s)) { offered = s; break; }
            }
          }

          if (offered !== null) {
            slots.push({
              start:     new Date(offered).toISOString(),
              end:       new Date(offered + durationMs).toISOString(),
              available: true,
              type:      'available',
            });
          }
        }
      } else {
        let s = etHourToUTC(curDayET, workStart).getTime();
        while (s + durationMs <= dayEnd) {
          const type = windowBusy(s) ? 'busy' : conflicts(s) ? 'overlap' : 'available';
          slots.push({
            start:     new Date(s).toISOString(),
            end:       new Date(s + durationMs).toISOString(),
            available: type === 'available',
            type,
          });
          s += slotIntervalMs;
        }
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

  // timeMin is 1ms before midnight ET of firstDayET so that all-day events on
  // firstDayET are included — events.list timeMin is exclusive, and all-day
  // events start at exactly midnight ET, so they'd be filtered out otherwise.
  const timeMin = new Date(etHourToUTC(firstDayET, 0).getTime() - 1);
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
    // All-day events have .date instead of .dateTime.
    // Use etHourToUTC so the times are explicit UTC ISO strings (no ambiguous
    // timezone-naive strings). Google's end.date is the exclusive next day,
    // so midnight ET of end.date is the correct actual end of the event.
    start: e.start.dateTime || etHourToUTC(e.start.date, 0).toISOString(),
    end:   e.end.dateTime   || etHourToUTC(e.end.date,   0).toISOString(),
  }));
}

module.exports = {
  getCalendarAuthUrl,
  exchangeCodeForTokens,
  getAvailableSlots,
  buildSlots,
  getCalendarEventTitles,
  createCalendarEvent,
};
