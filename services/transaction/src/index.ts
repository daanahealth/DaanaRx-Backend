import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authMiddleware } from './middleware/auth';
import transactionRoutes from './routes/transactions';
import cartsRoutes from './routes/carts';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(authMiddleware);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'transaction' }));

app.use('/carts', cartsRoutes);
app.use('/', transactionRoutes);

app.listen(PORT, () => console.log(`Transaction service running on port ${PORT}`));

export default app;
