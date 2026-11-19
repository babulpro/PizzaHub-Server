import express from 'express';
import jwt from 'jsonwebtoken';
import { collections } from '../config/db.js';
import { verifyToken, verifyRole } from '../middlewares/auth.js';

const router = express.Router();

/**
 * POST /api/auth/token
 * Generate a JWT for a user (creates user in MongoDB if not existing, for demo/testing)
 * Body: { "email": "admin@pizzahub.com", "name": "Elena", "role": "admin" }
 */
router.post('/token', async (req, res) => {
  try {
    const { email, name, role = 'customer', businessName } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required to generate a token.',
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Find or create demo user in DB
    let user = await collections.users.findOne({ email: cleanEmail });

    if (!user) {
      const newUser = {
        name: name || cleanEmail.split('@')[0],
        email: cleanEmail,
        image: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=300&q=80',
        role: role, // 'customer', 'vendor', 'admin'
        isBlocked: false,
        businessName: role === 'vendor' ? businessName || 'My Pizzeria' : undefined,
        subscriptionPlan: 'free',
        subscriptionExpiresAt: null,
        createdAt: new Date(),
      };

      const result = await collections.users.insertOne(newUser);
      user = { _id: result.insertedId, ...newUser };
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      message: 'Token generated successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        subscriptionPlan: user.subscriptionPlan,
        isBlocked: user.isBlocked,
      },
    });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/auth/me
 * Protected Route: Tests verifyToken
 */
router.get('/me', verifyToken, (req, res) => {
  res.json({
    success: true,
    message: 'Token verified successfully!',
    user: req.user,
  });
});

/**
 * GET /api/auth/admin-only
 * Protected Route: Tests verifyRole('admin')
 */
router.get('/admin-only', verifyToken, verifyRole('admin'), (req, res) => {
  res.json({
    success: true,
    message: 'Welcome Admin! You have access to this protected admin endpoint.',
    admin: req.user.name,
  });
});

export default router;