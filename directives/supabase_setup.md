# Supabase Database Setup Directive

## Overview
Set up Supabase PostgreSQL database with authentication for grace-ai prayer application.

## Database Schema

### Tables

#### 1. users (Extended from auth.users)
Supabase auth.users table handles basic auth. We extend with a custom profile table.

```sql
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

-- Policies
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
```

#### 2. prayers
Store all generated prayers.

```sql
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

-- Indexes
CREATE INDEX prayers_user_id_idx ON prayers(user_id);
CREATE INDEX prayers_created_at_idx ON prayers(created_at DESC);
CREATE INDEX prayers_emotion_idx ON prayers(emotion);
CREATE INDEX prayers_is_public_idx ON prayers(is_public);

-- Enable Row Level Security
ALTER TABLE prayers ENABLE ROW LEVEL SECURITY;

-- Policies
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
```

#### 3. prayer_likes (for future community features)
Track which users liked which prayers.

```sql
CREATE TABLE prayer_likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prayer_id UUID REFERENCES prayers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(prayer_id, user_id)
);

-- Indexes
CREATE INDEX prayer_likes_prayer_id_idx ON prayer_likes(prayer_id);
CREATE INDEX prayer_likes_user_id_idx ON prayer_likes(user_id);

-- Enable Row Level Security
ALTER TABLE prayer_likes ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Anyone can view likes"
  ON prayer_likes FOR SELECT
  USING (TRUE);

CREATE POLICY "Users can insert own likes"
  ON prayer_likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own likes"
  ON prayer_likes FOR DELETE
  USING (auth.uid() = user_id);
```

#### 4. subscriptions
Track Stripe subscription details.

```sql
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

-- Indexes
CREATE INDEX subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_stripe_customer_id_idx ON subscriptions(stripe_customer_id);

-- Enable Row Level Security
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);
```

#### 5. usage_logs
Track API usage for rate limiting.

```sql
CREATE TABLE usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_id TEXT, -- For non-logged-in users (IP or fingerprint)
  action TEXT NOT NULL CHECK (action IN ('prayer_generation', 'api_call')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX usage_logs_user_id_created_at_idx ON usage_logs(user_id, created_at DESC);
CREATE INDEX usage_logs_anonymous_id_created_at_idx ON usage_logs(anonymous_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own usage logs"
  ON usage_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Function to clean old logs (keep last 30 days)
CREATE OR REPLACE FUNCTION public.cleanup_old_usage_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM usage_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
```

## Environment Variables

Add to Vercel environment variables and `.env.local`:

```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Authentication Setup

### Google OAuth Configuration
1. Go to Supabase Dashboard → Authentication → Providers
2. Enable Google provider
3. Add Google OAuth credentials from Google Cloud Console
4. Add authorized redirect URL: `https://your-project-id.supabase.co/auth/v1/callback`

### Email/Password Configuration
1. Enable Email provider in Supabase Dashboard
2. Configure email templates
3. Set up SMTP if needed (or use Supabase default)

## Rate Limiting Logic

### Free Users
- 3 prayers/day for anonymous (tracked by IP or fingerprint)
- 10 prayers/day for registered free users

### Premium Users
- Unlimited prayers

### Implementation
Check usage in API before generating prayer:

```javascript
async function checkRateLimit(userId, anonymousId) {
  const today = new Date().toISOString().split('T')[0];

  if (userId) {
    // Check subscription tier
    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_tier, daily_prayer_count, last_prayer_date')
      .eq('id', userId)
      .single();

    if (profile.subscription_tier === 'premium') {
      return { allowed: true };
    }

    // Reset counter if new day
    if (profile.last_prayer_date !== today) {
      await supabase
        .from('profiles')
        .update({ daily_prayer_count: 0, last_prayer_date: today })
        .eq('id', userId);
      return { allowed: true };
    }

    // Check limit
    if (profile.daily_prayer_count >= 10) {
      return { allowed: false, limit: 10 };
    }

    return { allowed: true };
  } else {
    // Anonymous user - check by IP
    const { count } = await supabase
      .from('usage_logs')
      .select('*', { count: 'exact' })
      .eq('anonymous_id', anonymousId)
      .gte('created_at', today);

    if (count >= 3) {
      return { allowed: false, limit: 3 };
    }

    return { allowed: true };
  }
}
```

## Migration Steps

1. Create Supabase project at https://supabase.com
2. Run SQL schema in Supabase SQL Editor
3. Configure authentication providers
4. Add environment variables to Vercel
5. Install @supabase/supabase-js in project
6. Create Supabase client in src/lib/supabaseClient.js
7. Implement authentication flow
8. Add rate limiting to API endpoints

## Testing

1. Create test user account
2. Generate prayers and verify storage
3. Test rate limiting (free user limits)
4. Test subscription upgrade
5. Verify Row Level Security policies

## Cost Optimization

- Free tier: 500MB database, 50k monthly active users
- Archive old prayers after 1 year to reduce storage
- Use database functions for complex queries
- Enable connection pooling

## Monitoring

- Track daily active users
- Monitor database size
- Alert on rate limit hits
- Track prayer generation trends
