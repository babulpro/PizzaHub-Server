import { MongoClient, ServerApiVersion } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'PizzaHub';

if (!uri) {
  throw new Error('Please define the MONGODB_URI environment variable inside .env');
}

// Create a single MongoClient instance with connection pooling
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;

/**
 * Connect to MongoDB and cache the database instance
 */
export async function connectDB() {
  if (db) return db;

  try {
    await client.connect();
    db = client.db(dbName);
    console.log(`✅ MongoDB Connected successfully to database: "${dbName}"`);
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

/**
 * Helper to get the database instance
 */
export function getDB() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB() first.');
  }
  return db;
}

/**
 * Direct getters for the 4 required application collections
 */
export const collections = {
  get users() {
    return getDB().collection('users');
  },
  get menuItems() {
    return getDB().collection('menuItems');
  },
  get orders() {
    return getDB().collection('orders');
  },
  get transactions() {
    return getDB().collection('transactions');
  },
};