import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authMiddleware } from './middleware/auth';
import drugRoutes from './routes/drugs';
import locationRoutes from './routes/locations';
import lotRoutes from './routes/lots';
import unitRoutes from './routes/units';
import statsRoutes from './routes/stats';
import itemRoutes from './routes/items';
// Standalone router for GET /items/next-code. Must mount BEFORE itemRoutes
// so /items/next-code matches here instead of itemRoutes' GET /:id catch-all.
import itemsNextCodeRoutes from './routes/items-next-code';
import settingsRoutes from './routes/settings';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(authMiddleware);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'inventory' }));

app.use('/drugs', drugRoutes);
app.use('/locations', locationRoutes);
app.use('/lots', lotRoutes);
app.use('/units', unitRoutes);
app.use('/items', itemsNextCodeRoutes);
app.use('/items', itemRoutes);
app.use('/settings', settingsRoutes);
app.use('/', statsRoutes);
app.listen(PORT, () => console.log(`Inventory service running on port ${PORT}`));

export default app;
