const nodemailer = require('nodemailer');

function getTransporter() {
  const { EMAIL_FROM, EMAIL_APP_PASSWORD } = process.env;
  if (!EMAIL_FROM || !EMAIL_APP_PASSWORD) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_FROM,
      pass: EMAIL_APP_PASSWORD,
    },
  });
}

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
  const transporter = getTransporter();
  if (!transporter) {
    console.log('Email skipped: EMAIL_FROM or EMAIL_APP_PASSWORD not set');
    return;
  }

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
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: artistEmail,
      subject: `New booking: ${clientName}`,
      text: body,
    });
  } catch (err) {
    console.error('Failed to send booking confirmation email:', err.message);
  }
}

module.exports = { sendBookingConfirmation };
