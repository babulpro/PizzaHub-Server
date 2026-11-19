import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.js'; // 1. Added import

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// 1. CORS Configuration
app.use(
  cors({
    origin: [CLIENT_URL, 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// 2. JSON Body Parser with raw body hook for Stripe webhooks
app.use(
  express.json({
    verify: (req, res, buf) => {
      // Stores the raw Buffer needed for Stripe webhook signature verification
      req.rawBody = buf;
    },
  })
);

// 3. Health Check & Root Endpoints
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🍕 Welcome to PizzaHub API',
    version: '1.0.0',
    documentation: '/api/health',
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: `${process.uptime().toFixed(1)} seconds`,
    timestamp: new Date().toISOString(),
  });
});

// 4. Application Routes
app.use('/api/auth', authRoutes); // 2. Mounted auth routes

// 5. Global 404 Route Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// 6. Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// 7. Start Server after connecting to MongoDB
async function startServer() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 PizzaHub Server running on http://localhost:${PORT}`);
      console.log(`📡 Accepting client requests from: ${CLIENT_URL}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();