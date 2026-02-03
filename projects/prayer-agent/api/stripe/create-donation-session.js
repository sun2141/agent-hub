import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amount, userId, userEmail } = req.body;

    // Validate amount
    if (!amount || amount < 1000) {
      return res.status(400).json({ error: 'Invalid donation amount' });
    }

    // Create checkout session for one-time payment
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // One-time payment
      line_items: [
        {
          price_data: {
            currency: 'krw',
            product_data: {
              name: 'Grace-AI 후원',
              description: '따뜻한 마음을 담은 후원에 감사드립니다 💝',
              images: ['https://prayer-agent-94bewrwc9-sunhos-projects-7aadd0d2.vercel.app/og-image.png'],
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.VITE_APP_URL}?donation_success=true&amount=${amount}`,
      cancel_url: `${process.env.VITE_APP_URL}?donation_canceled=true`,
      customer_email: userEmail || undefined,
      metadata: {
        type: 'donation',
        user_id: userId || 'anonymous',
        amount: amount.toString(),
      },
      payment_intent_data: {
        metadata: {
          type: 'donation',
          user_id: userId || 'anonymous',
        },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Donation session creation error:', error);
    return res.status(500).json({
      error: 'Failed to create donation session',
      details: error.message
    });
  }
}
