import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import vapiRouter from './routes/vapi.js';
import dashboardRouter from './routes/dashboard.js';
import onboardingRouter from './routes/onboarding.js';
import { extractCalledNumberDetailed, normalizeE164Like } from './lib/tenantResolver.js';

const MAX_BODY_SIZE_BYTES = 4.5 * 1024 * 1024;
const COMMIT_SHA =
  process.env.COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.REVISION ||
  process.env.SOURCE_COMMIT ||
  'unknown';
const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP || new Date().toISOString();

function isDebugEnabled() {
  if (process.env.ENABLE_DEBUG_RESOLVE_TENANT === 'true') return true;
  const env = process.env.NODE_ENV;
  if (!env) return false;
  return env !== 'production';
}

const app = express();

app.use(express.json({ limit: MAX_BODY_SIZE_BYTES }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY_SIZE_BYTES }));

const defaultTrustedOrigins = ['https://ivaai.cz', 'https://www.ivaai.cz'];
const fromEnvOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];
const allowedOrigins = Array.from(new Set([...fromEnvOrigins, ...defaultTrustedOrigins]));
// ---- deploy sanity ----
const STARTED_AT = new Date().toISOString();

function getCommitSha() {
  // Railway (most common), GitHub Actions, generic build systems
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null
  );
}

app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'iva-backend',
    sha: getCommitSha(),
    startedAt: STARTED_AT,
    node: process.version,
  });
});

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Dev-only debug endpoint: test "To" extraction without DB.
// Usage:
// - GET /api/debug/extract-to?payload={...json...}
// - or GET /api/debug/extract-to?to=+420...
// - (optionally) send JSON body (non-standard for GET but supported in dev)
app.get('/api/debug/extract-to', (req, res) => {
  if (!isDebugEnabled()) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  let payload = null;

  // Query param payload (URL-encoded JSON)
  const payloadParam = req.query?.payload?.toString() ?? '';
  if (payloadParam) {
    try {
      payload = JSON.parse(payloadParam);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'invalid_payload_json' });
    }
  } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    payload = req.body;
  } else {
    const toParam = req.query?.to?.toString() ?? '';
    payload = toParam ? { to: toParam } : {};
  }

  const extracted = extractCalledNumberDetailed(payload);
  const normalized = extracted?.to ? normalizeE164Like(extracted.to) : null;

  return res.status(200).json({
    ok: true,
    to: extracted?.to ?? null,
    sourcePath: extracted?.sourcePath ?? null,
    normalizedTo: normalized,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'iva-backend' });
});

app.get('/version', (req, res) => {
  res.json({
    commit: COMMIT_SHA,
    timestamp: BUILD_TIMESTAMP,
  });
});

app.use('/vapi', vapiRouter); // /vapi/webhook
app.use('/api/vapi', vapiRouter); // /api/vapi/book_appointment, etc.
app.use('/api', dashboardRouter); // /api/bookings, /api/dashboard/*
app.use('/api/onboarding', onboardingRouter); // /api/onboarding/import_from_web

const port = Number(process.env.PORT ?? 8787);
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`[iva-backend] listening on http://${host}:${port}`);
  console.log(`[iva-backend] resolved PORT=${port}, HOST=${host}`);
});

