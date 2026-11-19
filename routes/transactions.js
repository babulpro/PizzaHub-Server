import express from 'express';
import { collections } from '../config/db.js';
import { verifyToken, verifyRole } from '../middlewares/auth.js';

const router = express.Router();

// ==========================================
// 1. ADMIN TRANSACTIONS (Read-Only)
// ==========================================

/**
 * GET /api/transactions
 * Admin views all platform transactions with vendor details & revenue metrics
 * Query params: ?status=completed
 */
router.get('/', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { status } = req.query;
    const matchQuery = {};

    if (status && status !== 'all') {
      matchQuery.status = status;
    }

    const transactions = await collections.transactions
      .aggregate([
        { $match: matchQuery },
        {
          $lookup: {
            from: 'users',
            localField: 'vendorId',
            foreignField: '_id',
            as: 'vendor',
          },
        },
        { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            'vendor.password': 0,
            'vendor.isBlocked': 0,
          },
        },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    // Calculate total verified platform revenue
    const totalRevenue = transactions
      .filter((t) => t.status === 'completed')
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    res.json({
      success: true,
      count: transactions.length,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      currency: 'USD',
      data: transactions,
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 2. VENDOR TRANSACTIONS (Own Invoices)
// ==========================================

/**
 * GET /api/transactions/my-transactions
 * Vendor views their own past subscription payments
 */
router.get(
  '/my-transactions',
  verifyToken,
  verifyRole('vendor'),
  async (req, res) => {
    try {
      const myTransactions = await collections.transactions
        .find({ vendorId: req.user._id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        count: myTransactions.length,
        data: myTransactions,
      });
    } catch (error) {
      console.error('Error fetching vendor transactions:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Note: No POST, PUT, PATCH, or DELETE routes exist here.
// Transactions are immutable and written exclusively by verified Stripe webhook events.

export default router;