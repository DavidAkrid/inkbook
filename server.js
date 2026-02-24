require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { rateLimit } = require('express-rate-limit');

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

app.get('/book/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'book.html'));
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
