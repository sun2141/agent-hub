import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Create Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

/**
 * Rate limiting helper
 * Checks if user can generate another prayer based on their tier and usage
 */
export async function checkRateLimit(userId = null, anonymousId = null) {
  const today = new Date().toISOString().split('T')[0];

  if (userId) {
    // Check subscription tier and daily usage for registered users
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('subscription_tier, daily_prayer_count, last_prayer_date')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error fetching profile:', error);
      return { allowed: false, error: 'Failed to check rate limit' };
    }

    // Premium users have unlimited access
    if (profile.subscription_tier === 'premium') {
      return { allowed: true, tier: 'premium' };
    }

    // Reset counter if it's a new day
    if (profile.last_prayer_date !== today) {
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          daily_prayer_count: 0,
          last_prayer_date: today
        })
        .eq('id', userId);

      if (updateError) {
        console.error('Error resetting counter:', updateError);
      }

      return { allowed: true, tier: 'free', remaining: 10 };
    }

    // Check if free user has reached limit (10/day)
    if (profile.daily_prayer_count >= 10) {
      return {
        allowed: false,
        tier: 'free',
        limit: 10,
        message: '오늘의 무료 기도문 생성 횟수를 모두 사용하셨습니다. 프리미엄으로 업그레이드하시면 무제한 이용하실 수 있습니다.'
      };
    }

    return {
      allowed: true,
      tier: 'free',
      remaining: 10 - profile.daily_prayer_count
    };
  } else if (anonymousId) {
    // Check usage for anonymous users (3/day)
    const { count, error } = await supabase
      .from('usage_logs')
      .select('*', { count: 'exact', head: true })
      .eq('anonymous_id', anonymousId)
      .gte('created_at', `${today}T00:00:00Z`);

    if (error) {
      console.error('Error checking anonymous usage:', error);
      return { allowed: false, error: 'Failed to check rate limit' };
    }

    if (count >= 3) {
      return {
        allowed: false,
        tier: 'anonymous',
        limit: 3,
        message: '오늘의 무료 기도문 생성 횟수(3회)를 모두 사용하셨습니다. 회원가입하시면 하루 10회까지 이용하실 수 있습니다.'
      };
    }

    return {
      allowed: true,
      tier: 'anonymous',
      remaining: 3 - count
    };
  }

  // Default: allow but log warning
  console.warn('Rate limit check called without userId or anonymousId');
  return { allowed: true };
}

/**
 * Log API usage for rate limiting
 */
export async function logUsage(userId = null, anonymousId = null, action = 'prayer_generation') {
  const { error } = await supabase
    .from('usage_logs')
    .insert({
      user_id: userId,
      anonymous_id: anonymousId,
      action: action
    });

  if (error) {
    console.error('Error logging usage:', error);
  }

  // Increment daily counter for registered users
  if (userId) {
    const { error: updateError } = await supabase.rpc('increment_prayer_count', {
      user_id_param: userId
    });

    if (updateError) {
      console.error('Error incrementing prayer count:', updateError);
    }
  }
}

/**
 * Save prayer to database
 */
export async function savePrayer(prayerData) {
  const { userId, title, content, topic, emotion, isPublic } = prayerData;

  if (!userId) {
    return { error: 'User must be logged in to save prayers' };
  }

  const { data, error } = await supabase
    .from('prayers')
    .insert({
      user_id: userId,
      title: title,
      content: content,
      topic: topic,
      emotion: emotion || 'peace',
      is_public: isPublic || false
    })
    .select()
    .single();

  if (error) {
    console.error('Error saving prayer:', error);
    return { error: error.message };
  }

  return { data, error: null };
}

/**
 * Get user's prayers with pagination
 */
export async function getUserPrayers(userId, { limit = 20, offset = 0, emotion = null } = {}) {
  let query = supabase
    .from('prayers')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (emotion) {
    query = query.eq('emotion', emotion);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Error fetching prayers:', error);
    return { data: [], error: error.message, count: 0 };
  }

  return { data, error: null, count };
}

/**
 * Delete prayer
 */
export async function deletePrayer(prayerId, userId) {
  const { error } = await supabase
    .from('prayers')
    .delete()
    .eq('id', prayerId)
    .eq('user_id', userId);

  if (error) {
    console.error('Error deleting prayer:', error);
    return { error: error.message };
  }

  return { error: null };
}

/**
 * Get user profile
 */
export async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    console.error('Error fetching profile:', error);
    return { data: null, error: error.message };
  }

  return { data, error: null };
}
