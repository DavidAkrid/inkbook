const { Resend } = require('resend');

function formatET(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

async function sendBookingConfirmation({ artistEmail, clientName, startTime, endTime, notes }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('Email skipped: RESEND_API_KEY not set');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const durationMs = new Date(endTime) - new Date(startTime);
  const durationHours = durationMs / (1000 * 60 * 60);
  const durationStr = durationHours === 1 ? '1 hour' : `${durationHours} hours`;

  const body = [
    `New booking confirmed!`,
    ``,
    `Client: ${clientName}`,
    `Date: ${formatET(startTime)}`,
    `End:   ${formatET(endTime)}`,
    `Duration: ${durationStr}`,
    notes ? `Notes: ${notes}` : null,
  ].filter(line => line !== null).join('\n');

  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: artistEmail,
      subject: `New booking: ${clientName}`,
      text: body,
    });
  } catch (err) {
    console.error('Failed to send booking confirmation email:', err.message);
  }
}

module.exports = { sendBookingConfirmation };
