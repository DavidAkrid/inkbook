const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const authMiddleware = require('../middleware/auth');
const { getCalendarAuthUrl, exchangeCodeForTokens } = require('../services/google-calendar');

// Step 1: Artist (must be logged in) clicks "Connect Google Calendar"
// Accepts the JWT either from the Authorization header (fetch) OR a ?token= query param
// (needed because browser <a> navigations can't send custom headers).
router.get('/google/calendar', async (req, res) => {
  // Resolve JWT from header or query param
  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const jwt = headerToken || req.query.token;

  if (!jwt) return res.status(401).send('Authentication required.');

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) return res.status(401).send('Invalid or expired session.');

  const userId = user.id;

  // Create nonce in DB (expires in 10 min)
  const { data: nonceRow, error } = await supabase
    .from('auth_nonces')
    .insert({ user_id: userId })
    .select('nonce')
    .single();

  if (error) {
    console.error('Failed to create auth nonce:', error.message);
    return res.status(500).send('Internal error starting calendar authorization.');
  }

  const authUrl = getCalendarAuthUrl(nonceRow.nonce);
  res.redirect(authUrl);
});

// Step 2: Google redirects back here with code + state (nonce)
router.get('/google/calendar/callback', async (req, res) => {
  const { code, state: nonce, error } = req.query;

  if (error) {
    return res.redirect('/?calendar=error&reason=' + encodeURIComponent(error));
  }

  if (!code || !nonce) {
    return res.redirect('/?calendar=error&reason=missing_params');
  }

  // Look up the nonce to find which artist this is for
  const { data: nonceRow, error: nonceError } = await supabase
    .from('auth_nonces')
    .select('user_id, expires_at')
    .eq('nonce', nonce)
    .single();

  if (nonceError || !nonceRow) {
    return res.redirect('/?calendar=error&reason=invalid_nonce');
  }

  if (new Date(nonceRow.expires_at) < new Date()) {
    await supabase.from('auth_nonces').delete().eq('nonce', nonce);
    return res.redirect('/?calendar=error&reason=expired');
  }

  // Exchange code for tokens
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error('Token exchange failed:', err.message);
    return res.redirect('/?calendar=error&reason=token_exchange_failed');
  }

  if (!tokens.refresh_token) {
    // This can happen if the user already granted access before without revoking.
    // Tell them to revoke and try again.
    return res.redirect('/?calendar=error&reason=no_refresh_token');
  }

  // Store refresh token + calendar ID on the artist's profile
  const { error: updateError } = await supabase
    .from('artists')
    .update({
      google_refresh_token: tokens.refresh_token,
      // Default calendar ID is the user's email (primary calendar)
      google_calendar_id: req.query.email || nonceRow.user_id,
    })
    .eq('id', nonceRow.user_id);

  if (updateError) {
    console.error('Failed to save calendar tokens:', updateError.message);
    return res.redirect('/?calendar=error&reason=db_save_failed');
  }

  // We need the artist's email for the calendar_id — fetch it
  const { data: artist } = await supabase
    .from('artists')
    .select('email')
    .eq('id', nonceRow.user_id)
    .single();

  if (artist?.email) {
    await supabase
      .from('artists')
      .update({ google_calendar_id: artist.email })
      .eq('id', nonceRow.user_id);
  }

  // Clean up nonce
  await supabase.from('auth_nonces').delete().eq('nonce', nonce);

  res.redirect('/?calendar=connected');
});

module.exports = router;
