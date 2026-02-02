-- Grace-AI Database Schema
-- Run this in Supabase SQL Editor

-- 1. Profiles table (extends auth.users)
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'premium')),
  subscription_expires_at TIMESTAMPTZ,
  daily_prayer_count INTEGER DEFAULT 0,
  last_prayer_date DATE,
  total_prayers_generated INTEGER DEFAULT 0
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Policies for profiles
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- Function to create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'display_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create profile automatically
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Prayers table
CREATE TABLE prayers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  topic TEXT NOT NULL,
  emotion TEXT DEFAULT 'peace' CHECK (emotion IN ('peace', 'gratitude', 'sadness', 'hope')),
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for prayers
CREATE INDEX prayers_user_id_idx ON prayers(user_id);
CREATE INDEX prayers_created_at_idx ON prayers(created_at DESC);
CREATE INDEX prayers_emotion_idx ON prayers(emotion);
CREATE INDEX prayers_is_public_idx ON prayers(is_public);

-- Enable Row Level Security
ALTER TABLE prayers ENABLE ROW LEVEL SECURITY;

-- Policies for prayers
CREATE POLICY "Users can view own prayers"
  ON prayers FOR SELECT
  USING (auth.uid() = user_id OR is_public = TRUE);

CREATE POLICY "Users can insert own prayers"
  ON prayers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own prayers"
  ON prayers FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own prayers"
  ON prayers FOR DELETE
  USING (auth.uid() = user_id);

-- 3. Prayer likes table
CREATE TABLE prayer_likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prayer_id UUID REFERENCES prayers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(prayer_id, user_id)
);

-- Indexes for prayer_likes
CREATE INDEX prayer_likes_prayer_id_idx ON prayer_likes(prayer_id);
CREATE INDEX prayer_likes_user_id_idx ON prayer_likes(user_id);

-- Enable Row Level Security
ALTER TABLE prayer_likes ENABLE ROW LEVEL SECURITY;

-- Policies for prayer_likes
CREATE POLICY "Anyone can view likes"
  ON prayer_likes FOR SELECT
  USING (TRUE);

CREATE POLICY "Users can insert own likes"
  ON prayer_likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own likes"
  ON prayer_likes FOR DELETE
  USING (auth.uid() = user_id);

-- 4. Subscriptions table
CREATE TABLE subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  stripe_customer_id TEXT UNIQUE NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'past_due', 'unpaid')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for subscriptions
CREATE INDEX subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_stripe_customer_id_idx ON subscriptions(stripe_customer_id);

-- Enable Row Level Security
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Policies for subscriptions
CREATE POLICY "Users can view own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- 5. Usage logs table
CREATE TABLE usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('prayer_generation', 'api_call')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for usage_logs
CREATE INDEX usage_logs_user_id_created_at_idx ON usage_logs(user_id, created_at DESC);
CREATE INDEX usage_logs_anonymous_id_created_at_idx ON usage_logs(anonymous_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- Policies for usage_logs
CREATE POLICY "Users can view own usage logs"
  ON usage_logs FOR SELECT
  USING (auth.uid() = user_id);

-- 6. Helper function to increment prayer count
CREATE OR REPLACE FUNCTION increment_prayer_count(user_id_param UUID)
RETURNS void AS $$
BEGIN
  UPDATE profiles
  SET
    daily_prayer_count = daily_prayer_count + 1,
    total_prayers_generated = total_prayers_generated + 1
  WHERE id = user_id_param;
END;
$$ LANGUAGE plpgsql;

-- 7. Function to clean old logs (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_usage_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM usage_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
