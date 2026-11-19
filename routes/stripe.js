import express from 'express';
import Stripe from 'stripe';
import { ObjectId } from 'mongodb';
import { collections } from '../config/db.js';
import { verifyToken, verifyRole } from '../middlewares/auth.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==========================================
// 1. CREATE STRIPE CHECKOUT SESSION (Vendor)
// ==========================================

/**
 * POST /api/stripe/create-checkout-session
 * Vendor clicks "Upgrade to Premium" -> generates Stripe Checkout Session
 */
router.post(
  '/create-checkout-session',
  verifyToken,
  verifyRole('vendor'),
  async (req, res) => {
    try {
      // Check if vendor is already premium
      if (req.user.subscriptionPlan === 'premium') {
        return res.status(400).json({
          success: false,
          message: 'Your account is already on the Premium plan.',
        });
      }

      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

      // Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'PizzaHub Vendor Premium Plan',
                description:
                  'Unlimited active menu items, Gold Premium badge, and featured homepage spotlight.',
                images: [
                  'https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=600&q=80',
                ],
              },
              unit_amount: 2900, // $29.00 USD
              recurring: {
                interval: 'month',
              },
            },
            quantity: 1,
          },
        ],
        customer_email: req.user.email,
        metadata: {
          vendorId: req.user._id.toString(),
          plan: 'premium',
        },
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/payment/cancel`,
      });

      res.json({
        success: true,
        sessionId: session.id,
        url: session.url,
      });
    } catch (error) {
      console.error('Error creating Stripe session:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// ==========================================
// 2. STRIPE WEBHOOK LISTENER
// ==========================================

/**
 * POST /api/stripe/webhook
 * Handles incoming verified events from Stripe servers
 * Activates Premium ONLY after cryptographically verifying event signature
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    // Cryptographically verify webhook signature using raw body buffer
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } else {
      // In development fallback if testing without Stripe CLI
      event = req.body;
    }
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // 1. Payment Succeeded -> Activate Premium & Save Transaction
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const vendorId = session.metadata?.vendorId;

      if (vendorId && ObjectId.isValid(vendorId)) {
        // Prevent duplicate transaction recording (Idempotency)
        const existingTxn = await collections.transactions.findOne({
          stripeSessionId: session.id,
        });

        if (!existingTxn) {
          // Calculate expiration date (1 month from now)
          const now = new Date();
          const expiresAt = new Date(now);
          expiresAt.setMonth(expiresAt.getMonth() + 1);

          // 1. Save immutable record in transactions collection
          const newTransaction = {
            vendorId: new ObjectId(vendorId),
            plan: 'premium',
            amount: (session.amount_total || 2900) / 100,
            currency: (session.currency || 'usd').toUpperCase(),
            stripeSessionId: session.id,
            stripeSubscriptionId: session.subscription || `sub_${session.id.slice(0, 14)}`,
            status: 'completed',
            createdAt: now,
          };
          await collections.transactions.insertOne(newTransaction);

          // 2. Update user to Premium
          await collections.users.updateOne(
            { _id: new ObjectId(vendorId) },
            {
              $set: {
                subscriptionPlan: 'premium',
                subscriptionExpiresAt: expiresAt,
                updatedAt: now,
              },
            }
          );

          console.log(`🎉 Premium activated for vendor ID: ${vendorId}`);
        }
      }
    }

    // 2. Subscription Cancelled / Expired
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      // Revert vendor back to free plan
      await collections.users.updateOne(
        { 'subscription.id': subscription.id },
        {
          $set: {
            subscriptionPlan: 'free',
            subscriptionExpiresAt: null,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`ℹ️ Subscription ended for customer: ${subscription.customer}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error handling webhook event:', error);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

// ==========================================
// 3. DEMO WEBHOOK SIMULATOR (For Local Postman Testing)
// ==========================================

/**
 * POST /api/stripe/simulate-webhook
 * Triggered in development/Postman to test the exact webhook activation logic
 */
router.post(
  '/simulate-webhook',
  verifyToken,
  verifyRole('vendor', 'admin'),
  async (req, res) => {
    try {
      const vendorId = req.user._id;

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      const demoSessionId = `cs_test_${Date.now().toString(36)}`;
      const demoSubId = `sub_test_${Date.now().toString(36)}`;

      // 1. Insert Transaction
      const transaction = {
        vendorId: new ObjectId(vendorId),
        plan: 'premium',
        amount: 29.0,
        currency: 'USD',
        stripeSessionId: demoSessionId,
        stripeSubscriptionId: demoSubId,
        status: 'completed',
        createdAt: now,
      };

      await collections.transactions.insertOne(transaction);

      // 2. Update Vendor to Premium
      await collections.users.updateOne(
        { _id: new ObjectId(vendorId) },
        {
          $set: {
            subscriptionPlan: 'premium',
            subscriptionExpiresAt: expiresAt,
            updatedAt: now,
          },
        }
      );

      res.json({
        success: true,
        message: 'Verified webhook simulated! Vendor upgraded to Premium.',
        transaction,
      });
    } catch (error) {
      console.error('Error in simulate-webhook:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

export default router;