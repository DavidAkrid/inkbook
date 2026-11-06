require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { rateLimit } = require('express-rate-limit');
const supabase = require('./services/supabase');

const artistRoutes = require('./routes/artist');
const bookingRoutes = require('./routes/booking');
const authRoutes = require('./routes/auth');

// Rate limiter for public client-facing booking routes (no auth required on these)
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const app = express();
app.set('trust proxy', 1); // Required for express-rate-limit behind Vercel's proxy
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets (HTML, CSS, client JS)
app.use(express.static(path.join(__dirname, 'public')));

// Public config endpoint — exposes only the safe/public env vars to the frontend
// (anon key is designed to be public; service key never leaves the server)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// API routes
app.use('/auth', authRoutes);
app.use('/api/requests', artistRoutes);
app.use('/api/book', bookingLimiter, bookingRoutes);

// Frontend page routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'artist.html'));
});

// The booking page is sent with the artist's theme already on <html>, so clients
// never see the default look flash first. Any failure falls back to the plain page
// (book.html still applies the theme itself once its data loads).
const BOOK_PAGE = path.join(__dirname, 'public', 'book.html');
let bookHtmlCache = null;
const THEME_IDS = ['sunset', 'forest', 'deep-sea', 'rose', 'ink', 'terminal-green']; // keep in sync with public/theme.js
const FONT_IDS  = ['mono', 'serif', 'gothic'];

app.get('/book/:token', async (req, res) => {
  try {
    if (!bookHtmlCache) bookHtmlCache = fs.readFileSync(BOOK_PAGE, 'utf8');

    const { data } = await supabase
      .from('booking_requests')
      .select('artists(theme, scanlines, glow, heading_font)')
      .eq('token', req.params.token)
      .single();
    const a = data?.artists;

    // Only whitelisted values are written into the HTML
    let attrs = '';
    if (a && THEME_IDS.includes(a.theme)) attrs += ` data-theme="${a.theme}"`;
    if (a && FONT_IDS.includes(a.heading_font)) attrs += ` data-font="${a.heading_font}"`;
    if (a?.scanlines) attrs += ' data-scanlines';
    if (a?.glow) attrs += ' data-glow';

    res.type('html').send(bookHtmlCache.replace('<html lang="en" data-page="client">', `<html lang="en" data-page="client"${attrs}>`));
  } catch (err) {
    res.sendFile(BOOK_PAGE);
  }
});

// Only start the HTTP server when running directly (local dev).
// On Vercel, api/index.js exports the app and Vercel handles the listening.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Dashboard:    http://localhost:${PORT}/`);
    console.log(`Login:        http://localhost:${PORT}/login`);
  });
}

module.exports = app;
