import express from 'express';
import { ObjectId } from 'mongodb';
import { collections } from '../config/db.js';
import { verifyToken, verifyRole } from '../middlewares/auth.js';

const router = express.Router();

// Helper: Check if a vendor has an active, non-expired Premium subscription
function isVendorPremium(user) {
  if (!user || user.subscriptionPlan !== 'premium') return false;
  if (!user.subscriptionExpiresAt) return true; // Active without explicit expiration
  return new Date(user.subscriptionExpiresAt) > new Date();
}

// ==========================================
// 1. PUBLIC ROUTES (Anyone can access)
// ==========================================

/**
 * GET /api/menu
 * Public Browse: Search, filter by category/location, and sort by price
 * Query params: ?search=margherita&category=Classic%20Pizzas&location=Manhattan&sortBy=price_asc
 */
router.get('/', async (req, res) => {
  try {
    const { search, category, location, sortBy } = req.query;

    // Filter only approved and active items for public view
    const matchQuery = {
      status: 'approved',
    };

    if (category && category !== 'all') {
      matchQuery.category = category;
    }

    if (location && location !== 'all') {
      matchQuery.location = { $regex: location, $options: 'i' };
    }

    if (search && search.trim() !== '') {
      matchQuery.$or = [
        { itemName: { $regex: search.trim(), $options: 'i' } },
        { description: { $regex: search.trim(), $options: 'i' } },
      ];
    }

    // Determine sorting criteria
    let sortCriteria = { createdAt: -1 }; // default: newest first
    if (sortBy === 'price_asc') {
      sortCriteria = { price: 1 };
    } else if (sortBy === 'price_desc') {
      sortCriteria = { price: -1 };
    }

    // Use MongoDB aggregation to join vendor info and prioritize Premium vendors
    const items = await collections.menuItems
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
        // Sort: Active Premium vendors first, then apply user-requested sort (e.g. price)
        {
          $addFields: {
            isPremium: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$vendor.subscriptionPlan', 'premium'] },
                    {
                      $or: [
                        { $eq: [{ $type: '$vendor.subscriptionExpiresAt' }, 'missing'] },
                        { $eq: ['$vendor.subscriptionExpiresAt', null] },
                        { $gt: ['$vendor.subscriptionExpiresAt', new Date()] },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $sort: {
            isPremium: -1, // Featured placement for Premium vendors
            ...sortCriteria,
          },
        },
      ])
      .toArray();

    res.json({
      success: true,
      count: items.length,
      data: items,
    });
  } catch (error) {
    console.error('Error fetching public menu:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 2. VENDOR ROUTES (Protected: vendor role)
// ==========================================

/**
 * GET /api/menu/vendor/quota
 * Fast endpoint for UI checks before displaying "Add Pizza" buttons/forms
 */
router.get('/vendor/quota', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const isPremium = isVendorPremium(req.user);
    const vendorIds = [
      req.user._id,
      ObjectId.isValid(req.user._id) ? new ObjectId(req.user._id) : null,
      req.user._id.toString(),
    ].filter(Boolean);

    const activeCount = await collections.menuItems.countDocuments({
      vendorId: { $in: vendorIds },
      status: { $in: ['approved', 'pending'] },
    });

    const limit = isPremium ? 'unlimited' : 3;
    const remaining = isPremium ? 'unlimited' : Math.max(0, 3 - activeCount);
    const canAddMore = isPremium || activeCount < 3;

    res.json({
      success: true,
      plan: isPremium ? 'premium' : 'free',
      isPremium,
      activeCount,
      limit,
      remaining,
      canAddMore,
    });
  } catch (error) {
    console.error('Error checking vendor quota:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/menu/vendor/my-items
 * Get all items created by the logged-in vendor with live quota metrics
 */
router.get('/vendor/my-items', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const vendorIds = [
      req.user._id,
      ObjectId.isValid(req.user._id) ? new ObjectId(req.user._id) : null,
      req.user._id.toString(),
    ].filter(Boolean);

    const items = await collections.menuItems
      .find({ vendorId: { $in: vendorIds } })
      .sort({ createdAt: -1 })
      .toArray();

    const isPremium = isVendorPremium(req.user);
    const activeCount = items.filter((i) =>
      ['approved', 'pending'].includes(i.status)
    ).length;
    const limit = isPremium ? 'unlimited' : 3;
    const remaining = isPremium ? 'unlimited' : Math.max(0, 3 - activeCount);
    const canAddMore = isPremium || activeCount < 3;

    res.json({
      success: true,
      count: items.length,
      quota: {
        plan: isPremium ? 'premium' : 'free',
        isPremium,
        activeCount,
        limit,
        remaining,
        canAddMore,
      },
      data: items,
    });
  } catch (error) {
    console.error('Error fetching vendor items:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/menu
 * Create a new menu item
 * Rule: Free plan allows max 3 active/pending items. Premium is unlimited.
 */
router.post('/', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const {
      itemName,
      category,
      description,
      price,
      location,
      images,
      prepTime,
      isSpicy,
      isVegetarian,
    } = req.body || {};

    // Validation
    if (!itemName || !category || !description || price === undefined || !location) {
      return res.status(400).json({
        success: false,
        message: 'Please provide itemName, category, description, price, and location.',
      });
    }

    const numPrice = Number(price);
    if (isNaN(numPrice) || numPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Price must be a valid positive number.',
      });
    }

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one item image URL (from ImgBB) is required.',
      });
    }

    // Check Free Plan item quota (max 3 active or pending items for non-premium vendors)
    const isPremium = isVendorPremium(req.user);
    if (!isPremium) {
      const vendorIds = [
        req.user._id,
        ObjectId.isValid(req.user._id) ? new ObjectId(req.user._id) : null,
        req.user._id.toString(),
      ].filter(Boolean);

      const activeCount = await collections.menuItems.countDocuments({
        vendorId: { $in: vendorIds },
        status: { $in: ['approved', 'pending'] },
      });

      if (activeCount >= 3) {
        return res.status(403).json({
          success: false,
          message: 'Free plan limit reached (max 3 active items). Please upgrade to Premium for unlimited items.',
          quota: {
            plan: 'free',
            activeCount,
            limit: 3,
            canAddMore: false,
          },
        });
      }
    }

    const newItem = {
      vendorId: req.user._id,
      itemName: itemName.trim(),
      category: category.trim(),
      description: description.trim(),
      price: Number(price),
      location: location.trim(),
      images: images,
      prepTime: prepTime || '20-25 min',
      isSpicy: Boolean(isSpicy),
      isVegetarian: Boolean(isVegetarian),
      status: 'pending', // Default status is pending until Admin approves
      createdAt: new Date(),
    };

    const result = await collections.menuItems.insertOne(newItem);

    res.status(201).json({
      success: true,
      message: 'Menu item submitted successfully! It is pending admin approval.',
      data: { _id: result.insertedId, ...newItem },
    });
  } catch (error) {
    console.error('Error adding menu item:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/menu/:id
 * Vendor updates their own item
 */
router.patch('/:id', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    const item = await collections.menuItems.findOne({ _id: new ObjectId(id) });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    // Ownership check: vendors can only edit their own items
    if (item.vendorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not own this menu item.' });
    }

    const { itemName, category, description, price, location, images, prepTime, isSpicy, isVegetarian } = req.body || {};

    const updateFields = {};
    if (itemName) updateFields.itemName = itemName.trim();
    if (category) updateFields.category = category.trim();
    if (description) updateFields.description = description.trim();
    if (price !== undefined) {
      const numPrice = Number(price);
      if (isNaN(numPrice) || numPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Price must be a valid positive number.',
        });
      }
      updateFields.price = numPrice;
    }
    if (location) updateFields.location = location.trim();
    if (Array.isArray(images) && images.length > 0) updateFields.images = images;
    if (prepTime) updateFields.prepTime = prepTime;
    if (isSpicy !== undefined) updateFields.isSpicy = Boolean(isSpicy);
    if (isVegetarian !== undefined) updateFields.isVegetarian = Boolean(isVegetarian);
    updateFields.updatedAt = new Date();

    await collections.menuItems.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    res.json({
      success: true,
      message: 'Menu item updated successfully.',
    });
  } catch (error) {
    console.error('Error updating menu item:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/menu/:id/toggle
 * Vendor toggles item availability (approved <-> inactive)
 */
router.patch('/:id/toggle', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    const item = await collections.menuItems.findOne({ _id: new ObjectId(id) });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    if (item.vendorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not own this item.' });
    }

    if (item.status === 'pending' || item.status === 'rejected') {
      return res.status(400).json({
        success: false,
        message: `Cannot toggle an item with status '${item.status}'.`,
      });
    }

    const newStatus = item.status === 'approved' ? 'inactive' : 'approved';

    // If activating on free plan, ensure <= 3 active items
    const isPremium = isVendorPremium(req.user);
    if (newStatus === 'approved' && !isPremium) {
      const vendorIds = [
        req.user._id,
        ObjectId.isValid(req.user._id) ? new ObjectId(req.user._id) : null,
        req.user._id.toString(),
      ].filter(Boolean);

      const activeCount = await collections.menuItems.countDocuments({
        vendorId: { $in: vendorIds },
        status: { $in: ['approved', 'pending'] },
      });

      if (activeCount >= 3) {
        return res.status(403).json({
          success: false,
          message: 'Free plan limit reached (max 3 active items). Deactivate another item or upgrade to Premium.',
          quota: {
            plan: 'free',
            activeCount,
            limit: 3,
            canAddMore: false,
          },
        });
      }
    }

    await collections.menuItems.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: newStatus, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: `Item availability updated to '${newStatus}'.`,
      status: newStatus,
    });
  } catch (error) {
    console.error('Error toggling menu item:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/menu/:id
 * Vendor deletes their own item
 */
router.delete('/:id', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    const item = await collections.menuItems.findOne({ _id: new ObjectId(id) });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    if (item.vendorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not own this item.' });
    }

    await collections.menuItems.deleteOne({ _id: new ObjectId(id) });

    res.json({
      success: true,
      message: 'Menu item deleted successfully.',
    });
  } catch (error) {
    console.error('Error deleting menu item:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 3. ADMIN ROUTES (Protected: admin role)
// ==========================================

/**
 * GET /api/menu/admin/all
 * Admin views all items across all vendors
 */
router.get('/admin/all', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { status, category, search } = req.query;
    const filter = {};

    if (status && status !== 'all') {
      filter.status = status;
    }
    if (category && category !== 'all') {
      filter.category = category;
    }
    if (search && search.trim() !== '') {
      filter.itemName = { $regex: search.trim(), $options: 'i' };
    }

    const items = await collections.menuItems
      .aggregate([
        { $match: filter },
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
          },
        },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    res.json({
      success: true,
      count: items.length,
      data: items,
    });
  } catch (error) {
    console.error('Admin all items error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/menu/admin/:id/status
 * Admin approves or rejects a menu item
 * Body: { "status": "approved" } or { "status": "rejected" } or { "status": "inactive" }
 */
router.patch('/admin/:id/status', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!status || !['approved', 'rejected', 'inactive', 'pending'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid status: 'approved', 'rejected', 'inactive', or 'pending' in the request body.",
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    const result = await collections.menuItems.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    res.json({
      success: true,
      message: `Menu item status updated to '${status}'.`,
    });
  } catch (error) {
    console.error('Admin update status error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/menu/admin/:id
 * Admin removes an inappropriate item
 */
router.delete('/admin/:id', verifyToken, verifyRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    const result = await collections.menuItems.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    res.json({
      success: true,
      message: 'Inappropriate menu item deleted by admin.',
    });
  } catch (error) {
    console.error('Admin delete item error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 4. PUBLIC SINGLE ITEM (Keep at bottom)
// ==========================================

/**
 * GET /api/menu/:id
 * View single menu item
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    const items = await collections.menuItems
      .aggregate([
        { $match: { _id: new ObjectId(id) } },
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
          },
        },
      ])
      .toArray();

    if (!items || items.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    // A rejected item must never be visible to customers
    if (items[0].status === 'rejected') {
      return res.status(404).json({ success: false, message: 'Menu item not found or unavailable.' });
    }

    res.json({
      success: true,
      data: items[0],
    });
  } catch (error) {
    console.error('Error fetching item details:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;