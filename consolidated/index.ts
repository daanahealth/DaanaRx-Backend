// Daana consolidated API — a single Express app that mounts every service's
// routers DIRECTLY under the same public prefixes the gateway used to proxy to.
//
// Why: on Render's free plan each of the 5 separate services spins down after
// ~15 min idle and cold-starts (~12-30s) independently, so the first sign-in
// fans out across a cascade of cold starts and the app appears hung. Collapsing
// them into one process means ONE cold start, and a single service fits the
// free keep-warm budget.
//
// The public contract is identical to the proxying gateway:
//   /auth/*  /inventory/*  /transactions/*  /notifications/*
// so the frontend (NEXT_PUBLIC_API_URL) needs no change.

// Load env BEFORE any service module — their supabase/jwt utils read
// process.env at import time.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';

// One shared auth middleware (the per-service copies are identical: verify JWT,
// attach req.user / req.clinic). Per-route requireAuth/requireRole in each
// router read req.user, so a single global attach covers them all.
import { authMiddleware } from '../services/auth/src/middleware/auth';

// Auth
import authRoutes from '../services/auth/src/routes/auth';
import invitationRoutes from '../services/auth/src/routes/invitations';
// Inventory
import drugRoutes from '../services/inventory/src/routes/drugs';
import locationRoutes from '../services/inventory/src/routes/locations';
import lotRoutes from '../services/inventory/src/routes/lots';
import unitRoutes from '../services/inventory/src/routes/units';
import statsRoutes from '../services/inventory/src/routes/stats';
import itemRoutes from '../services/inventory/src/routes/items';
import itemsNextCodeRoutes from '../services/inventory/src/routes/items-next-code';
import settingsRoutes from '../services/inventory/src/routes/settings';
// Transaction
import transactionRoutes from '../services/transaction/src/routes/transactions';
import cartsRoutes from '../services/transaction/src/routes/carts';
import reportsRoutes, { transactionLogRoutes } from '../services/transaction/src/routes/reports';
// Notification
import feedbackRoutes from '../services/notification/src/routes/feedback';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(authMiddleware);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'daana-api', mode: 'consolidated' }),
);
// Single process now — warmup is a trivial OK (kept so the frontend's
// sign-in warmup call still succeeds and wakes this one service).
app.get('/warmup', (_req, res) =>
  res.json({ warmedAt: new Date().toISOString(), consolidated: true }),
);

// ---- Auth (more-specific /auth/invitations before /auth) ----
app.use('/auth/invitations', invitationRoutes);
app.use('/auth', authRoutes);

// ---- Inventory (specific routers before the root statsRoutes) ----
app.use('/inventory/drugs', drugRoutes);
app.use('/inventory/locations', locationRoutes);
app.use('/inventory/lots', lotRoutes);
app.use('/inventory/units', unitRoutes);
app.use('/inventory/items', itemsNextCodeRoutes); // /items/next-code before itemRoutes' /:id
app.use('/inventory/items', itemRoutes);
app.use('/inventory/settings', settingsRoutes);
app.use('/inventory', statsRoutes); // /stats, /expiry/*

// ---- Transaction (specific prefixes before the root transactionRoutes) ----
app.use('/transactions/carts', cartsRoutes);
app.use('/transactions/reports', reportsRoutes);
app.use('/transactions/transactions', transactionLogRoutes);
app.use('/transactions', transactionRoutes); // /, /all, /checkout, /:id

// ---- Notification ----
app.use('/notifications', feedbackRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () =>
  console.log(`Daana consolidated API running on port ${PORT}
  /auth/*           (auth + invitations)
  /inventory/*      (drugs, locations, lots, units, items, settings, stats)
  /transactions/*   (carts, reports, transaction log, checkout)
  /notifications/*  (feedback)`),
);

export default app;
