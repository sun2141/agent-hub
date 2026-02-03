-- Create donations table for tracking one-time donations
CREATE TABLE IF NOT EXISTS donations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  stripe_payment_intent TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for user lookups
CREATE INDEX IF NOT EXISTS donations_user_id_idx ON donations(user_id);
CREATE INDEX IF NOT EXISTS donations_created_at_idx ON donations(created_at DESC);

-- Enable Row Level Security
ALTER TABLE donations ENABLE ROW LEVEL SECURITY;

-- Allow users to view their own donations
CREATE POLICY "Users can view own donations"
  ON donations FOR SELECT
  USING (auth.uid() = user_id);

-- Allow insert from service role (webhook)
CREATE POLICY "Service role can insert donations"
  ON donations FOR INSERT
  WITH CHECK (true);

COMMENT ON TABLE donations IS 'Tracks one-time donations from users';
COMMENT ON COLUMN donations.amount IS 'Donation amount in Korean Won (KRW)';
