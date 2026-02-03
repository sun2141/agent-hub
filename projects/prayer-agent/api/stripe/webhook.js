import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: {
    bodyParser: false
  }
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        await handleSubscriptionUpdate(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await handleSubscriptionCanceled(subscription);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await handleInvoicePaymentSucceeded(invoice);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

async function handleCheckoutCompleted(session) {
  // Check if this is a donation or subscription
  const isDonation = session.metadata?.type === 'donation';

  if (isDonation) {
    // Handle donation
    const userId = session.metadata?.user_id;
    const amount = parseInt(session.metadata?.amount || '0');

    console.log(`Donation received: ${amount} KRW from user ${userId || 'anonymous'}`);

    // Log donation to database (optional - create donations table if needed)
    if (userId && userId !== 'anonymous') {
      await supabase
        .from('donations')
        .insert({
          user_id: userId,
          amount,
          stripe_payment_intent: session.payment_intent,
          created_at: new Date()
        })
        .catch(err => {
          // If donations table doesn't exist yet, just log
          console.log('Donations table not yet created, skipping database log');
        });
    }

    return;
  }

  // Handle subscription
  const userId = session.metadata?.supabase_user_id;
  if (!userId) return;

  const { error } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      status: 'active'
    });

  if (error) {
    console.error('Error creating subscription:', error);
    return;
  }

  // Update user profile to premium
  await supabase
    .from('profiles')
    .update({
      subscription_tier: 'premium',
      subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    })
    .eq('id', userId);
}

async function handleSubscriptionUpdate(subscription) {
  const userId = subscription.metadata?.supabase_user_id;
  if (!userId) return;

  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000),
      current_period_end: new Date(subscription.current_period_end * 1000),
      cancel_at_period_end: subscription.cancel_at_period_end || false
    })
    .eq('user_id', userId);

  if (error) {
    console.error('Error updating subscription:', error);
    return;
  }

  // Update profile
  if (subscription.status === 'active') {
    await supabase
      .from('profiles')
      .update({
        subscription_tier: 'premium',
        subscription_expires_at: new Date(subscription.current_period_end * 1000)
      })
      .eq('id', userId);
  }
}

async function handleSubscriptionCanceled(subscription) {
  const userId = subscription.metadata?.supabase_user_id;
  if (!userId) return;

  await supabase
    .from('subscriptions')
    .update({
      status: 'canceled'
    })
    .eq('user_id', userId);

  // Downgrade to free
  await supabase
    .from('profiles')
    .update({
      subscription_tier: 'free',
      subscription_expires_at: null
    })
    .eq('id', userId);
}

async function handleInvoicePaymentSucceeded(invoice) {
  const userId = invoice.subscription_details?.metadata?.supabase_user_id;
  if (!userId) return;

  // Log successful payment
  console.log(`Payment succeeded for user ${userId}`);
}

async function handleInvoicePaymentFailed(invoice) {
  const userId = invoice.subscription_details?.metadata?.supabase_user_id;
  if (!userId) return;

  // Update subscription status
  await supabase
    .from('subscriptions')
    .update({
      status: 'past_due'
    })
    .eq('user_id', userId);

  console.log(`Payment failed for user ${userId}`);
}
