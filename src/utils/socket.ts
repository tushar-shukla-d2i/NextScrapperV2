import { Server as SocketIOServer } from 'socket.io';
import type { Server } from 'http';

let io: SocketIOServer;

export const initSocket = (httpServer: Server) => {
  io = new SocketIOServer(httpServer, {
    cors: { origin: '*' }
  });
  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};
