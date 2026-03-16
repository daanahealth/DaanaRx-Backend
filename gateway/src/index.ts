import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';
const TRANSACTION_SERVICE_URL = process.env.TRANSACTION_SERVICE_URL || 'http://localhost:3003';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004';

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
];

app.use(cors({ origin: allowedOrigins, credentials: true }));

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'gateway',
    services: { auth: AUTH_SERVICE_URL, inventory: INVENTORY_SERVICE_URL, transaction: TRANSACTION_SERVICE_URL, notification: NOTIFICATION_SERVICE_URL },
  })
);

function makeProxy(target: string, pathPrefix: string): Options {
  return {
    target,
    changeOrigin: true,
    pathRewrite: { [`^${pathPrefix}`]: '' },
    on: {
      error: (err: any, _req: any, res: any) => {
        console.error(`[Gateway] Proxy error to ${target}:`, err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: `Service unavailable: ${pathPrefix}` });
        }
      },
    },
  };
}

app.use('/auth', createProxyMiddleware(makeProxy(AUTH_SERVICE_URL, '/auth')));
app.use('/inventory', createProxyMiddleware(makeProxy(INVENTORY_SERVICE_URL, '/inventory')));
app.use('/transactions', createProxyMiddleware(makeProxy(TRANSACTION_SERVICE_URL, '/transactions')));
app.use('/notifications', createProxyMiddleware(makeProxy(NOTIFICATION_SERVICE_URL, '/notifications')));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () =>
  console.log(`API Gateway running on port ${PORT}
  /auth        → ${AUTH_SERVICE_URL}
  /inventory   → ${INVENTORY_SERVICE_URL}
  /transactions → ${TRANSACTION_SERVICE_URL}
  /notifications → ${NOTIFICATION_SERVICE_URL}`)
);

export default app;
