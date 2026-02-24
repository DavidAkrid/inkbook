# InkBook — Tattoo Artist Booking Tool

Artist creates a booking link pre-loaded with design notes → client self-schedules into real calendar availability → Google Calendar event created automatically.

Multi-user. Each artist signs in with Google, connects their own calendar, and manages their own booking links. Deployable on Vercel.

---

## Current Features

- Artist signs in with Google, connects their Google Calendar
- Creates booking links pre-loaded with client name, duration, and design notes
- Client self-schedules from real calendar availability (week grid view)
- Google Calendar event created automatically on booking
- **Artist Settings** — configurable working hours, days off, buffer time between appointments, and display name shown to clients
- Client booking page shows artist's display name and marks past dates / days off visually

---

## Setup (~30 min)

### 1. Install dependencies

From inside the `tattoo-booking` folder, run:

```
npm install
```

---

### 2. Supabase project

1. Create a free account at [supabase.com](https://supabase.com) → **New project**
2. **SQL Editor → New query** → paste the full contents of `schema.sql` → **Run**
   - If you already have an existing database, run only the `ALTER TABLE` block near the bottom of `schema.sql` to add new columns without dropping your data
3. **Settings → API** → copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_KEY` (keep this secret — never commit it)

---

### 3. Google Cloud project

This is your developer setup — use your own Google account, not the artist's.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with **your** Google account
2. **Create a new project** (top-left dropdown → New Project, give it any name)
3. **APIs & Services → Library** → search **Google Calendar API** → Enable
4. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Fill in App name (e.g. "InkBook") and your support email → Save and continue through the steps
   - Under **Test users**: add every Google account that will use the app during testing — your Gmail and the artist's Gmail. Anyone not listed here will get a "not authorized" error.
5. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs — add both:
     - `http://localhost:3000/auth/google/calendar/callback`
     - `https://your-app.vercel.app/auth/google/calendar/callback` (add after deploying)
   - Click **Create**
6. Copy **Client ID** → `GOOGLE_CLIENT_ID` and **Client Secret** → `GOOGLE_CLIENT_SECRET`

---

### 4. Enable Google sign-in in Supabase

This is what powers the "Sign in with Google" button on the login page.

1. In Supabase: **Authentication → Providers → Google** → toggle on
2. Paste the same **Client ID** and **Client Secret** from step 3
3. Copy the **Callback URL** shown by Supabase (looks like `https://xxxx.supabase.co/auth/v1/callback`)
4. Go back to Google Cloud Console → your OAuth credential → add that Supabase callback URL to **Authorized redirect URIs** → Save
5. In Supabase: **Authentication → URL Configuration**
   - **Site URL**: `http://localhost:3000`
   - **Redirect URLs**: add `http://localhost:3000/**`

---

### 5. Configure your environment

Your `.env` file should already exist. Make sure it has these values filled in:

```
PORT=3000
BASE_URL=http://localhost:3000

SUPABASE_URL=           # from step 2
SUPABASE_SERVICE_KEY=   # from step 2
SUPABASE_ANON_KEY=      # from step 2

GOOGLE_CLIENT_ID=       # from step 3
GOOGLE_CLIENT_SECRET=   # from step 3
GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3000/auth/google/calendar/callback
```

---

### 6. Run it

```
npm start
```

Then:

1. Go to `http://localhost:3000` — you'll be redirected to the login page
2. Click **Sign in with Google** and authorize
3. You land on the dashboard. Click **Connect Google Calendar** and authorize
4. You're fully set up. Create a booking request and test the flow.

---

## Testing the full flow

1. **On the dashboard**: create a booking request with a client name, duration, and some notes
2. **Copy the generated link** and open it in an incognito window (simulates the client)
3. The client page should show your design notes and a grid of available time slots
4. Pick a slot, enter an email address, and confirm
5. Check your Google Calendar — the event should appear with the design notes in the description
6. The client's email (if provided) will receive a Google Calendar invite automatically

---

## Deploy to Vercel

1. Push the project to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → **New Project** → import the repo
3. Add all environment variables in Vercel's dashboard (same as `.env`, skip `PORT`)
4. Update these two values for production:
   - `BASE_URL` → your Vercel URL (e.g. `https://inkbook.vercel.app`)
   - `GOOGLE_CALENDAR_REDIRECT_URI` → `https://your-app.vercel.app/auth/google/calendar/callback`
5. Add the production redirect URI to your Google Cloud OAuth credential
6. Update Supabase **Site URL** and **Redirect URLs** to your Vercel domain
7. Deploy

---

## File structure

```
tattoo-booking/
├── api/
│   └── index.js              # Vercel serverless entry point
├── middleware/
│   └── auth.js               # Verifies Supabase JWT on protected routes
├── routes/
│   ├── auth.js               # Google Calendar OAuth flow (per user)
│   ├── artist.js             # Booking request CRUD (requires login)
│   └── booking.js            # Client availability + booking (no login required)
├── services/
│   ├── supabase.js           # Supabase client (service role)
│   └── google-calendar.js    # Availability check + calendar event creation
├── public/
│   ├── login.html            # Sign in with Google
│   ├── artist.html           # Artist dashboard
│   ├── book.html             # Client booking page
│   └── styles.css            # Shared styles
├── schema.sql                # Run once in Supabase SQL editor
├── vercel.json               # Vercel routing config
├── server.js                 # Express app
└── .env.example              # Config template
```
