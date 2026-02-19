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

    // 로그인 사용자는 무제한 (도네이션 모델)
    return { allowed: true, tier: 'free' };
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

    if (count >= 5) {
      return {
        allowed: false,
        tier: 'anonymous',
        limit: 5,
        message: '오늘의 기도 체험 횟수(5회)를 모두 사용하셨습니다. 회원가입하시면 무제한으로 기도를 맡길 수 있습니다.'
      };
    }

    return {
      allowed: true,
      tier: 'anonymous',
      remaining: 5 - count
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

// =============================================
// 예약 기도 시스템 (Scheduled Prayer System)
// =============================================

/**
 * 사용자의 기도 스케줄 가져오기
 */
export async function getPrayerSchedule(userId) {
  const { data, error } = await supabase
    .from('prayer_schedules')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116: no rows found
    console.error('Error fetching schedule:', error);
    return { data: null, error: error.message };
  }

  return { data, error: null };
}

/**
 * 기도 스케줄 생성/업데이트
 */
export async function savePrayerSchedule(userId, scheduleData) {
  const { data: existing } = await getPrayerSchedule(userId);

  if (existing) {
    // 업데이트
    const { data, error } = await supabase
      .from('prayer_schedules')
      .update({
        ...scheduleData,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('Error updating schedule:', error);
      return { data: null, error: error.message };
    }
    return { data, error: null };
  } else {
    // 새로 생성
    const { data, error } = await supabase
      .from('prayer_schedules')
      .insert({
        user_id: userId,
        ...scheduleData
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating schedule:', error);
      return { data: null, error: error.message };
    }
    return { data, error: null };
  }
}

/**
 * 오늘의 기도 슬롯 가져오기
 */
export async function getTodayPrayerSlots(userId) {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('daily_prayer_slots')
    .select(`
      *,
      prayer_executions (
        id,
        prayer_title,
        prayer_content,
        executed_at,
        user_viewed
      )
    `)
    .eq('user_id', userId)
    .eq('date', today)
    .order('scheduled_time', { ascending: true });

  if (error) {
    console.error('Error fetching today slots:', error);
    return { data: [], error: error.message };
  }

  return { data: data || [], error: null };
}

/**
 * 최근 기도 실행 내역 가져오기
 */
export async function getRecentPrayerExecutions(userId, limit = 10) {
  const { data, error } = await supabase
    .from('prayer_executions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('executed_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching executions:', error);
    return { data: [], error: error.message };
  }

  return { data: data || [], error: null };
}

/**
 * 확인하지 않은 기도 가져오기
 */
export async function getUnviewedPrayers(userId) {
  const { data, error } = await supabase
    .from('prayer_executions')
    .select('*')
    .eq('user_id', userId)
    .eq('user_viewed', false)
    .eq('status', 'completed')
    .order('executed_at', { ascending: false });

  if (error) {
    console.error('Error fetching unviewed prayers:', error);
    return { data: [], error: error.message };
  }

  return { data: data || [], error: null };
}

/**
 * 기도 확인 표시
 */
export async function markPrayerAsViewed(executionId) {
  const { error } = await supabase.rpc('mark_prayer_viewed', {
    execution_uuid: executionId
  });

  if (error) {
    console.error('Error marking prayer as viewed:', error);
    return { error: error.message };
  }

  return { error: null };
}

/**
 * 기도 통계 가져오기
 */
export async function getPrayerStats(userId) {
  const { data: profile } = await getUserProfile(userId);
  const { data: executions } = await getRecentPrayerExecutions(userId, 100);
  const { data: unviewed } = await getUnviewedPrayers(userId);

  return {
    totalPrayers: profile?.total_prayers_generated || 0,
    currentStreak: profile?.current_streak || 0,
    longestStreak: profile?.longest_streak || 0,
    scheduledPrayersTotal: executions?.length || 0,
    unviewedCount: unviewed?.length || 0,
    lastPrayerDate: profile?.last_prayer_date
  };
}
