'use strict';
/**
 * StudyHub — unified server
 * -------------------------
 * One process, one port, three apps:
 *   /              -> the main StudyHub site (login lives ONLY here, at "/")
 *   /community/... -> Community + Calendar (Express sub-app, own session store)
 *   /library/...   -> the ebook Library (Express sub-app)
 *
 * Login only ever happens on the main site (Supabase Auth, including email
 * OTP — configure Supabase's SMTP with your Gmail App Password, see README).
 * Community/Calendar never show their own login form: right after signing in
 * on the main site, the browser calls POST /api/bridge/session (below) to
 * get a matching Community session, transparently, via Supabase's verified
 * identity — never a second password.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Same Supabase project the main site's public/js/config.js points at.
// Only the public anon key is needed here — verifying a person's own access
// token this way never requires the secret service-role key.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qphpmktvrgmyzknjrdhi.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_serGYM32YtR7msZ2JwNDdQ_1HFjWzuV';
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
const server = http.createServer(app);

// Community/Calendar's live chat + presence, isolated on their own
// Socket.IO namespace and path so they can never collide with anything
// else mounted on this same server later.
const io = new SocketIOServer(server, { path: '/community/socket.io' });
const communityIO = io.of('/community');

const createCommunityApp = require('./apps/community/server');
const createLibraryApp = require('./apps/library/server');

const communityApp = createCommunityApp(communityIO);
const libraryApp = createLibraryApp();

/* ------------------------------------------------------------------ */
/* SSO bridge: Supabase login -> Community session                     */
/* ------------------------------------------------------------------ */
app.post('/api/bridge/session', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: 'Missing StudyHub session.' });

    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Invalid or expired session.' });

    const { id, email, user_metadata } = data.user;
    const name = (user_metadata && (user_metadata.full_name || user_metadata.name)) || null;

    // A per-request client authenticated as this person, so the profiles
    // read below is subject to their own row-level security policy (they
    // can only ever see their own row) rather than needing a service key.
    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: profile } = await asUser.from('profiles').select('role').eq('user_id', id).maybeSingle();
    const realRole = profile && profile.role; // 'student' | 'teacher' | 'admin' | undefined
    const communityRole = realRole === 'teacher' || realRole === 'admin' ? 'teacher' : 'student';

    const result = communityApp.locals.bridgeLogin({ supabaseId: id, email, name, role: communityRole });
    result.home = realRole === 'admin' ? '/admin-dashboard.html' : realRole === 'teacher' ? '/teacher-dashboard.html' : '/dashboard.html';
    res.json(result);
  } catch (err) {
    console.error('[bridge] failed:', err);
    res.status(500).json({ error: 'Could not start a Community session.' });
  }
});

/* ------------------------------------------------------------------ */
/* Sub-apps                                                            */
/* ------------------------------------------------------------------ */
app.use('/community', communityApp);
app.use('/library', libraryApp);

/* ------------------------------------------------------------------ */
/* Main site (login, dashboard, profile, ...)                          */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).send('Not found.'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try:  PORT=4000 npm start`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  StudyHub is running -> http://localhost:${PORT}`);
  console.log(`    Main site  : http://localhost:${PORT}/`);
  console.log(`    Community  : http://localhost:${PORT}/community/`);
  console.log(`    Calendar   : http://localhost:${PORT}/community/#/calendar`);
  console.log(`    Library    : http://localhost:${PORT}/library/\n`);
});
