# StudyHub

One Node app, one port, three things merged together — now organized as a
clear **frontend/** (everything served to the browser) and **backend/**
(the server and data) split.

| Path | What it is |
|---|---|
| `/` | Login, dashboard, profile, etc. (static site + Supabase Auth) |
| `/community/` | Community: chat, Q&A, announcements, resources |
| `/community/#/calendar` | Calendar (lives inside the Community app) |
| `/library/` | The ebook Library |

**Login only ever happens at `/` (`index.html`).** Community, Calendar and
Library never show a login form — see "How login works" below.

## Project layout

```
frontend/
  public/      <- main site (login, dashboard, teacher/admin dashboards, notes, ...)
  community/   <- Community + Calendar's HTML/CSS/JS (no server code here)
  library/     <- Library's HTML/CSS/JS + reader vendor libs (epub.js, pdf.js)

backend/
  server.js              <- entry point: mounts everything below on one port
  package.json
  .env.example
  supabase/               <- SQL schema + RLS policies (run these in Supabase)
  apps/
    community/
      server.js           <- Express sub-app, mounted at /community
      db.js                <- in-memory + JSON-file "database"
      calendar.js, lib/     <- calendar feature
      data/db.json         <- created on first run, not committed
    library/
      server.js           <- Express sub-app, mounted at /library
      data.json            <- book catalog
      books/, covers/       <- the actual files
```

The split is purely about *where a file lives*, not about how the app runs:
it's still one `npm start`, one port. `backend/server.js` serves
`frontend/public` directly and mounts the two apps in `backend/apps/`, which
in turn serve `frontend/community` and `frontend/library`.

## 1. Install

```bash
cd backend
npm install
cp .env.example .env
```

`.env` already has working defaults for `SUPABASE_URL` / `SUPABASE_ANON_KEY`
(the same project `frontend/public/js/config.js` uses), so you can skip
straight to step 2 unless you're pointing this at a different Supabase
project.

## 2. Set up the database

Run every file in `backend/supabase/` against your Supabase project, in
this order (each one is additive — safe to run once and forget):

```
schema.sql
migration_profile_and_identity.sql
migration_real_institutions.sql
migration_phone_signup.sql
migration_map_and_feed.sql
admin_schema.sql
dashboard_schema.sql
ai_teacher_schema.sql
notes_schema.sql
```

`notes_schema.sql` is the newest one — it extends the existing `resources`
table for the Notes feature (search/upload/save/rate) and creates the
`notes-uploads` storage bucket.

## 3. Set up Gmail so Supabase can send OTP codes

Your login page already does everything (sign-up email OTP, password reset)
through **Supabase Auth** — there's no separate OTP code to write. You just
need to tell Supabase to send those emails through your own Gmail account
instead of Supabase's limited default sender:

1. Turn on 2-Step Verification on the Gmail account: `myaccount.google.com/security`
2. Create an App Password: `myaccount.google.com/apppasswords`
3. In your **Supabase Dashboard** → Authentication → Settings → SMTP Settings, turn on
   "Enable Custom SMTP" and fill in:
   - Host: `smtp.gmail.com`
   - Port: `465`
   - Username: your Gmail address
   - Password: the 16-character App Password (not your normal Gmail password)
   - Sender email: the same Gmail address

That's it — sign-up OTP emails and password-reset emails now come from your
Gmail account.

## 4. Run it

```bash
cd backend
npm start
```

Then open `http://localhost:3000`.

## How login works (SSO bridge)

- Community/Calendar were originally a *separate* app with their own
  username+password login screen and their own session tokens.
- That login screen has been **removed**. Instead, right after you sign in
  on the main site, `frontend/public/js/auth-bridge.js` calls
  `POST /api/bridge/session` with your Supabase access token. The server
  verifies it with Supabase, reads your real role (student/teacher/admin),
  then silently creates (or reuses, keeping the role in sync) a matching
  Community account and hands the browser a Community session token —
  stored under `sh_token` in `localStorage`, which is exactly what
  Community's front end already reads.
- If Community/Calendar ever find no valid session (e.g. you open the link
  directly without logging in first, or the bridge failed), they redirect
  straight to `/index.html` instead of showing their own login form.
- Signing out (`studyHubSignOut()`) clears both the Supabase session and the
  Community token.
- Library never had a login of its own — it stayed as-is, just re-pathed
  under `/library`.
- The Home logo and Back button in Community/Library/Calendar read a
  `studyhub_home` value (also set by the bridge) to send you back to the
  *correct* dashboard for your role.

## Notes / things you'll likely want to change

- `TEACHER_CODE` (`.env`) — only matters if you build a UI for Community's
  own teacher sign-up code; StudyHub's real role comes from Supabase, not
  this.
- `LIBRARIAN_CODE` (`.env`) — PIN for the "librarian" unlock button inside
  `/library/` that lets someone add/edit books.
- The Community app's data lives in `backend/apps/community/data/db.json`
  (created on first run). The Library's book catalog is
  `backend/apps/library/data.json`. Neither is a real database — fine for a
  hackathon, not for production.
- Colors/fonts across Community and Library were remapped to match the main
  site's dark-navy + blue/violet, Sora/Inter theme (same CSS variable names,
  new values) — if you tweak the brand palette, change it once in
  `frontend/public/css/auth.css`'s `:root` and mirror the values into
  `frontend/community/css/style.css` and `frontend/library/style.css`.
- The official logo lives in one place only:
  `frontend/public/assets/studyhub-logo.png`, referenced by absolute path
  (`/assets/studyhub-logo.png`) from every page, including Community and
  Library.
