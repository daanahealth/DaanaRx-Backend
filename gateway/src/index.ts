import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createProxyMiddleware } from 'http-proxy-middleware';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';
const TRANSACTION_SERVICE_URL = process.env.TRANSACTION_SERVICE_URL || 'http://localhost:3003';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004';
const BUGS_SERVICE_URL = process.env.BUGS_SERVICE_URL || 'http://localhost:3005';

// --- Resilience tuning (env-overridable) ------------------------------------
// On Render's free plan, downstream services spin down after ~15 min idle and
// take 12-30s to cold-start. A naive proxy gives up and returns 502 while the
// service is waking. These settings make the gateway WAIT OUT the cold start
// and RETRY transient connection failures instead of failing fast.
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 60_000; // wait up to 60s per attempt for a cold-starting upstream
const PROXY_MAX_ATTEMPTS = Number(process.env.PROXY_MAX_ATTEMPTS) || 4;  // total attempts before surfacing a 502
const PROXY_BACKOFF_BASE_MS = Number(process.env.PROXY_BACKOFF_BASE_MS) || 750;
const PROXY_BACKOFF_CAP_MS = Number(process.env.PROXY_BACKOFF_CAP_MS) || 8_000;

// Connection-level errors that mean "upstream not reachable yet" — almost
// always a cold start on Render. Safe to retry because no response has begun.
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

function isRetryable(err: any): boolean {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  return /socket hang up|ECONN|timeout/i.test(err.message || '');
}

// Exponential backoff with a cap. attempt is 1-based.
function backoffMs(attempt: number): number {
  return Math.min(PROXY_BACKOFF_BASE_MS * 2 ** (attempt - 1), PROXY_BACKOFF_CAP_MS);
}

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
];

app.use(cors({ origin: allowedOrigins, credentials: true }));

// Buffer the raw request body so a retried proxy attempt can re-send it.
// http-proxy-middleware normally streams req -> upstream, but a stream can only
// be consumed once; buffering lets us replay the body on every retry.
app.use(express.raw({ type: () => true, limit: '10mb' }));
app.use((req, _res, next) => {
  (req as any).rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  next();
});

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'gateway',
    services: { auth: AUTH_SERVICE_URL, inventory: INVENTORY_SERVICE_URL, transaction: TRANSACTION_SERVICE_URL, notification: NOTIFICATION_SERVICE_URL, bugs: BUGS_SERVICE_URL },
  })
);

function makeResilientProxy(target: string, pathPrefix: string) {
  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: { [`^${pathPrefix}`]: '' },
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
    on: {
      // Replay the buffered body on each attempt (the original req stream was
      // already drained by express.raw above).
      proxyReq: (proxyReq: any, req: any) => {
        const body: Buffer | undefined = req.rawBody;
        if (body && body.length) {
          if (req.headers['content-type'] && !proxyReq.getHeader('content-type')) {
            proxyReq.setHeader('content-type', req.headers['content-type']);
          }
          proxyReq.setHeader('content-length', Buffer.byteLength(body));
          proxyReq.write(body);
        }
      },
      error: (err: any, req: any, res: any) => {
        const attempt: number = req._proxyAttempt || 1;
        const canRetry =
          isRetryable(err) &&
          attempt < PROXY_MAX_ATTEMPTS &&
          res && !res.headersSent && !res.writableEnded;

        if (canRetry) {
          const delay = backoffMs(attempt);
          req._proxyAttempt = attempt + 1;
          console.warn(
            `[Gateway] ${pathPrefix} -> ${target} attempt ${attempt}/${PROXY_MAX_ATTEMPTS} failed (${err.code || err.message}); retrying in ${delay}ms (likely cold start)`
          );
          setTimeout(() => proxy(req, res, () => {}), delay);
          return;
        }

        console.error(
          `[Gateway] Proxy error to ${target} after ${attempt} attempt(s):`,
          err.code || err.message
        );
        if (res && !res.headersSent) {
          res.status(502).json({
            error: `Service unavailable: ${pathPrefix}`,
            code: err.code || 'PROXY_ERROR',
            attempts: attempt,
          });
        }
      },
    },
  });
  return proxy;
}

app.use('/auth', makeResilientProxy(AUTH_SERVICE_URL, '/auth'));
app.use('/inventory', makeResilientProxy(INVENTORY_SERVICE_URL, '/inventory'));
app.use('/transactions', makeResilientProxy(TRANSACTION_SERVICE_URL, '/transactions'));
app.use('/notifications', makeResilientProxy(NOTIFICATION_SERVICE_URL, '/notifications'));

// Bugs dashboard is a static HTML app that fetches its API via a RELATIVE path
// ('api/feedback'). Serving it under a prefix only resolves correctly when the
// document URL carries a trailing slash, so redirect '/bugs' -> '/bugs/' first.
// Redirect the exact slash-less '/bugs' to '/bugs/' so the static dashboard's
// relative API fetch resolves to '/bugs/api/feedback'. Match on originalUrl so
// the trailing-slash form falls through to the proxy (no self-redirect loop).
app.use('/bugs', (req, res, next) => {
  if (req.originalUrl.split('?')[0] === '/bugs') return res.redirect(308, '/bugs/');
  next();
});
app.use('/bugs', makeResilientProxy(BUGS_SERVICE_URL, '/bugs'));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () =>
  console.log(`API Gateway running on port ${PORT}
  proxy: timeout=${PROXY_TIMEOUT_MS}ms attempts=${PROXY_MAX_ATTEMPTS}
  /auth        → ${AUTH_SERVICE_URL}
  /inventory   → ${INVENTORY_SERVICE_URL}
  /transactions → ${TRANSACTION_SERVICE_URL}
  /notifications → ${NOTIFICATION_SERVICE_URL}
  /bugs        → ${BUGS_SERVICE_URL}`)
);

export default app;
