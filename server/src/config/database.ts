import mongoose from 'mongoose';
import { config } from './index';

export const connectDatabase = async (): Promise<void> => {
  try {
    const conn = await mongoose.connect(config.mongodb.uri);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch {
    throw new Error('Could not connect to MongoDB. Check MONGODB_URI and network access.');
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

mongoose.connection.on('error', (err) => {
  console.error(`MongoDB connection error: ${err.message || 'check connectivity'}`);
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected');
});
