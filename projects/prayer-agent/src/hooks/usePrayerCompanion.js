import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  getTodayPrayerSlots,
  getUnviewedPrayers,
  getPrayerStats,
  getPrayerSchedule,
  markPrayerAsViewed,
  supabase
} from '../lib/supabaseClient';

/**
 * 기도 동반자 훅
 *
 * 클라이언트 사이드에서 기도 스케줄을 모니터링하고
 * 시간이 되면 "기도 실행" 상태를 업데이트합니다.
 */
export function usePrayerCompanion() {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState(null);
  const [todaySlots, setTodaySlots] = useState([]);
  const [unviewedPrayers, setUnviewedPrayers] = useState([]);
  const [stats, setStats] = useState(null);
  const [currentPrayer, setCurrentPrayer] = useState(null); // 현재 진행 중인 기도
  const [isActive, setIsActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef(null);

  // 데이터 로드
  const loadData = useCallback(async () => {
    if (!user) return;

    const [scheduleRes, slotsRes, unviewedRes, statsRes] = await Promise.all([
      getPrayerSchedule(user.id),
      getTodayPrayerSlots(user.id),
      getUnviewedPrayers(user.id),
      getPrayerStats(user.id)
    ]);

    setSchedule(scheduleRes.data);
    setTodaySlots(slotsRes.data || []);
    setUnviewedPrayers(unviewedRes.data || []);
    setStats(statsRes);
    setIsActive(scheduleRes.data?.is_active || false);
    setLoading(false);
  }, [user]);

  // 초기 로드
  useEffect(() => {
    loadData();
  }, [loadData]);

  // 주기적 체크 (1분마다)
  useEffect(() => {
    if (!user || !isActive) return;

    const checkPendingPrayers = async () => {
      const now = new Date();

      // pending 슬롯 중 시간이 지난 것 찾기
      const pendingSlots = todaySlots.filter(slot => {
        const slotTime = new Date(slot.scheduled_time);
        return slot.status === 'pending' && slotTime <= now;
      });

      if (pendingSlots.length > 0) {
        // 클라이언트에서 기도 "실행"
        for (const slot of pendingSlots) {
          await executePrayerClient(slot);
        }

        // 데이터 리로드
        await loadData();
      }
    };

    // 매 분마다 체크
    intervalRef.current = setInterval(checkPendingPrayers, 60000);
    // 초기 1회도 실행
    checkPendingPrayers();

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [user, isActive, todaySlots, loadData]);

  // 클라이언트 사이드 기도 실행
  const executePrayerClient = async (slot) => {
    if (!user) return;

    try {
      // 저장된 기도문에서 선택
      let prayerContent = '';
      let prayerTitle = '오늘의 기도';
      let prayerId = null;
      let source = 'generated';

      if (schedule?.saved_prayer_ids?.length > 0 && schedule.prayer_source !== 'generate') {
        const randomIdx = Math.floor(Math.random() * schedule.saved_prayer_ids.length);
        const { data: prayer } = await supabase
          .from('prayers')
          .select('id, title, content')
          .eq('id', schedule.saved_prayer_ids[randomIdx])
          .single();

        if (prayer) {
          prayerId = prayer.id;
          prayerTitle = prayer.title;
          prayerContent = prayer.content;
          source = 'saved';
        }
      }

      // 저장된 기도문이 없으면 템플릿 사용
      if (!prayerContent) {
        const topic = schedule?.default_topic || '일상의 평안';
        prayerContent = getSimplePrayer(topic);
        prayerTitle = `${topic}을 위한 기도`;
      }

      // 기도 실행 로그 생성
      const { data: execution, error: execError } = await supabase
        .from('prayer_executions')
        .insert({
          schedule_id: slot.schedule_id,
          user_id: user.id,
          scheduled_time: slot.scheduled_time,
          prayer_id: prayerId,
          prayer_title: prayerTitle,
          prayer_content: prayerContent,
          prayer_source: source,
          status: 'completed'
        })
        .select()
        .single();

      if (execError) {
        console.error('Error executing prayer:', execError);
        return;
      }

      // 슬롯 업데이트
      await supabase
        .from('daily_prayer_slots')
        .update({
          status: 'completed',
          execution_id: execution.id
        })
        .eq('id', slot.id);

      // 현재 기도 알림 표시
      setCurrentPrayer({
        ...execution,
        isNew: true
      });

      // 3초 후 현재 기도 알림 숨기기
      setTimeout(() => {
        setCurrentPrayer(null);
      }, 8000);

    } catch (error) {
      console.error('Error in client prayer execution:', error);
    }
  };

  // 기도 확인
  const viewPrayer = async (executionId) => {
    const result = await markPrayerAsViewed(executionId);
    if (!result.error) {
      setUnviewedPrayers(prev => prev.filter(p => p.id !== executionId));
    }
    return result;
  };

  // 다음 기도 시간
  const getNextPrayerTime = () => {
    const now = new Date();
    const pending = todaySlots
      .filter(s => s.status === 'pending')
      .sort((a, b) => new Date(a.scheduled_time) - new Date(b.scheduled_time));

    if (pending.length === 0) return null;

    const nextTime = new Date(pending[0].scheduled_time);
    const diffMs = nextTime - now;
    const diffMins = Math.round(diffMs / 60000);

    if (diffMins < 60) {
      return `${diffMins}분 후`;
    } else {
      return nextTime.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    }
  };

  return {
    schedule,
    todaySlots,
    unviewedPrayers,
    stats,
    currentPrayer,
    isActive,
    loading,
    nextPrayerTime: getNextPrayerTime(),
    viewPrayer,
    refresh: loadData
  };
}

/**
 * 간단한 기도문 템플릿 (API 호출 없음)
 */
function getSimplePrayer(topic) {
  const templates = [
    `하나님, 오늘도 ${topic}을(를) 위해 기도드립니다.\n\n이 기도를 올리는 사람의 마음에 평안을 주시고, 하루하루 은혜 가운데 살아갈 수 있도록 인도해 주세요.\n\n힘들고 지칠 때에도 주님의 사랑을 느낄 수 있게 하시고, 감사한 마음으로 하루를 보낼 수 있게 해주세요.\n\n예수님의 이름으로 기도합니다. 아멘.`,

    `사랑의 하나님,\n\n${topic}에 대해 간절히 기도합니다.\n\n주님의 뜻 안에서 모든 것이 이루어지기를 소망하며, 오늘 하루도 감사와 기쁨으로 채워주시길 바랍니다.\n\n어려운 순간에도 주님이 함께 하심을 믿으며, 담대한 마음을 주세요.\n\n예수님의 이름으로 기도드립니다. 아멘.`,

    `은혜로우신 하나님,\n\n${topic}을(를) 주님의 손에 맡깁니다.\n\n오늘도 주님의 사랑과 보호 아래 안전하게 지켜주시고, 마음에 평화를 부어주세요.\n\n주님이 예비하신 좋은 것들을 기대하며, 하나님의 인도하심을 따르겠습니다.\n\n감사드리며, 예수님의 이름으로 기도합니다. 아멘.`,

    `전능하신 하나님,\n\n${topic}을(를) 위해 주님 앞에 나아갑니다.\n\n주님의 지혜와 사랑으로 인도해 주시고, 필요한 모든 것을 채워주시길 기도합니다.\n\n오늘 하루도 주님의 은혜 안에서 기쁨과 감사로 살아갈 수 있게 해주세요.\n\n주님을 신뢰하며, 예수님의 이름으로 기도합니다. 아멘.`
  ];

  return templates[Math.floor(Math.random() * templates.length)];
}
