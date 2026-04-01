import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import workflowRoutes from './routes/workflow';
import proxyRoutes from './routes/proxy';
import { initSocket } from './utils/socket';
import { initQueue } from './services/queueService';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for massive HTML payloads

// Initialize WebSockets
const io = initSocket(httpServer);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  // Clients can join a room matching their Job ID to receive logs
  socket.on('join_job', (jobId) => {
    socket.join(`job_${jobId}`);
    console.log(`Socket ${socket.id} joined room job_${jobId}`);
  });
});

// Main router
app.use('/api/workflows', workflowRoutes);
app.use('/api/proxy', proxyRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the Queue Worker
initQueue();

httpServer.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
