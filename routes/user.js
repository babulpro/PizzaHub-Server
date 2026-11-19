import express from 'express';
import { ObjectId } from 'mongodb';
import { collections } from '../config/db.js';
import { verifyToken, verifyRole } from '../middlewares/auth.js';

const router = express.Router();

// ==========================================
// 1. PROFILE MANAGEMENT (Customer & Vendor)
// ==========================================

/**
 * PATCH /api/users/profile
 * Logged-in user updates their own editable profile information
 */
router.patch('/profile', verifyToken, async (req, res) => {
  try {
    const { name, image, phone, address, businessName } = req.body || {};

    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Name is required.',
      });
    }

    const updateFields = {
      name: name.trim(),
      updatedAt: new Date(),
    };

    if (image !== undefined) updateFields.image = image.trim();
    if (phone !== undefined) updateFields.phone = phone.trim();
    if (address !== undefined) updateFields.address = address.trim();

    // Only vendors can set businessName
    if (req.user.role === 'vendor' && businessName) {
      updateFields.businessName = businessName.trim();
    }

    // Security: role, isBlocked, and subscriptionPlan are strictly excluded here

    await collections.users.updateOne(
      { _id: req.user._id },
      { $set: updateFields }
    );

    const updatedUser = await collections.users.findOne(
      { _id: req.user._id },
      { projection: { password: 0 } }
    );

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: updatedUser,
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 2. ADMIN USER MANAGEMENT
// ==========================================

/**
 * GET /api/users
 * Admin views all registered users with search and role filter
 * Query params: ?search=amina&role=customer
 */
router.get('/', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { search, role } = req.query;
    const filter = {};

    if (role && role !== 'all') {
      filter.role = role;
    }

    if (search && search.trim() !== '') {
      filter.$or = [
        { name: { $regex: search.trim(), $options: 'i' } },
        { email: { $regex: search.trim(), $options: 'i' } },
        { businessName: { $regex: search.trim(), $options: 'i' } },
      ];
    }

    const users = await collections.users
      .find(filter, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/users/:id
 * Admin views a single user's detailed information
 */
router.get('/:id', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID.' });
    }

    const user = await collections.users.findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/users/:id/block
 * Admin toggles block / unblock on a user account
 */
router.patch('/:id/block', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID.' });
    }

    // Security check: Admin cannot block their own account
    if (req.user._id.toString() === id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot block your own admin account.',
      });
    }

    const user = await collections.users.findOne({ _id: new ObjectId(id) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const nextBlockedState = !user.isBlocked;

    await collections.users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isBlocked: nextBlockedState, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: nextBlockedState
        ? `User ${user.name} has been blocked.`
        : `User ${user.name} has been unblocked.`,
      isBlocked: nextBlockedState,
    });
  } catch (error) {
    console.error('Error toggling block status:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;