import express from 'express';
import { ObjectId } from 'mongodb';
import { collections } from '../config/db.js';
import { verifyToken, verifyRole } from '../middlewares/auth.js';

const router = express.Router();

// ==========================================
// 1. CUSTOMER ROUTES
// ==========================================

/**
 * POST /api/orders
 * Customer places a new pizza order
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const { itemId, deliveryDate, deliveryAddress, message } = req.body || {};

    // Security check: Admins cannot place food orders
    if (req.user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin accounts cannot place customer food orders.',
      });
    }

    if (!itemId || !deliveryDate || !deliveryAddress) {
      return res.status(400).json({
        success: false,
        message: 'Please provide itemId, deliveryDate, and deliveryAddress.',
      });
    }

    if (!ObjectId.isValid(itemId)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID.' });
    }

    // Fetch the menu item
    const item = await collections.menuItems.findOne({ _id: new ObjectId(itemId) });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }

    // Business Rule: Only approved items can be ordered
    if (item.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Only approved and active menu items can be ordered.',
      });
    }

    // Business Rule: Vendors cannot order their own items
    if (item.vendorId.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Vendors cannot place orders for their own menu items.',
      });
    }

    // Business Rule: Prevent duplicate active orders for the same item and delivery date
    const existingActiveOrder = await collections.orders.findOne({
      customerId: req.user._id,
      itemId: item._id,
      deliveryDate: deliveryDate,
      status: { $in: ['pending', 'accepted'] },
    });

    if (existingActiveOrder) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active order for this item on that delivery date.',
      });
    }

    const now = new Date();
    const newOrder = {
      itemId: item._id,
      vendorId: item.vendorId,
      customerId: req.user._id,
      deliveryDate: deliveryDate,
      deliveryAddress: deliveryAddress.trim(),
      message: message ? message.trim() : '',
      totalPrice: item.price,
      status: 'pending', // Default status: pending
      timeline: [
        {
          status: 'pending',
          label: 'Order Placed',
          timestamp: now,
          note: 'Order submitted to restaurant kitchen.',
        },
      ],
      createdAt: now,
    };

    const result = await collections.orders.insertOne(newOrder);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully! Waiting for the restaurant to confirm.',
      data: { _id: result.insertedId, ...newOrder },
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/orders/my-orders
 * Customer retrieves their own orders with item & vendor details
 */
router.get('/my-orders', verifyToken, async (req, res) => {
  try {
    const orders = await collections.orders
      .aggregate([
        { $match: { customerId: req.user._id } },
        {
          $lookup: {
            from: 'menuItems',
            localField: 'itemId',
            foreignField: '_id',
            as: 'item',
          },
        },
        { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
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

    res.json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error('Error fetching customer orders:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/orders/:id/cancel
 * Customer cancels their own pending order
 */
router.patch('/:id/cancel', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID.' });
    }

    const order = await collections.orders.findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Ownership check: customers cannot cancel another customer's order
    if (order.customerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot cancel another customer's order.",
      });
    }

    // Business Rule: Can only cancel pending orders
    if (order.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel an order that is already ${order.status}.`,
      });
    }

    const cancelEvent = {
      status: 'cancelled',
      label: 'Cancelled by Customer',
      timestamp: new Date(),
      note: 'Order was cancelled prior to restaurant acceptance.',
    };

    await collections.orders.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { status: 'cancelled', updatedAt: new Date() },
        $push: { timeline: cancelEvent },
      }
    );

    res.json({
      success: true,
      message: 'Order cancelled successfully.',
    });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 2. VENDOR ROUTES
// ==========================================

/**
 * GET /api/orders/vendor/my-orders
 * Vendor retrieves all incoming orders for their restaurant
 */
router.get('/vendor/my-orders', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const orders = await collections.orders
      .aggregate([
        { $match: { vendorId: req.user._id } },
        {
          $lookup: {
            from: 'menuItems',
            localField: 'itemId',
            foreignField: '_id',
            as: 'item',
          },
        },
        { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'users',
            localField: 'customerId',
            foreignField: '_id',
            as: 'customer',
          },
        },
        { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            'customer.password': 0,
            'customer.isBlocked': 0,
          },
        },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    res.json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error('Error fetching vendor orders:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/orders/:id/status
 * Vendor accepts or rejects a pending order
 * Body: { "status": "accepted" } or { "status": "rejected", "note": "Kitchen closed" }
 */
router.patch('/:id/status', verifyToken, verifyRole('vendor'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body || {};

    if (!status || !['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Vendor action must be either 'accepted' or 'rejected'.",
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID.' });
    }

    const order = await collections.orders.findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Ownership check: vendors cannot touch orders for other restaurants
    if (order.vendorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot modify an order that belongs to another restaurant.",
      });
    }

    // Business Rule: Only pending orders can be accepted or rejected, and only once
    if (order.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Order has already been ${order.status} and cannot be modified.`,
      });
    }

    const timelineEvent = {
      status,
      label: status === 'accepted' ? 'Accepted by Restaurant' : 'Order Declined',
      timestamp: new Date(),
      note: note || (status === 'accepted' ? 'The oven is fired up for your pizza!' : 'Kitchen unable to fulfill slot.'),
    };

    await collections.orders.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { status, updatedAt: new Date() },
        $push: { timeline: timelineEvent },
      }
    );

    res.json({
      success: true,
      message: `Order ${status} successfully.`,
      status,
    });
  } catch (error) {
    console.error('Error responding to order:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 3. SINGLE ORDER DETAILS
// ==========================================

/**
 * GET /api/orders/:id
 * View order details and timeline
 */
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid order ID.' });
    }

    const order = await collections.orders.findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Access control: Only the customer who ordered, the receiving vendor, or an admin can view
    const isCustomer = order.customerId.toString() === req.user._id.toString();
    const isVendor = order.vendorId.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isCustomer && !isVendor && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Forbidden: Access denied.' });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('Error fetching order details:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;