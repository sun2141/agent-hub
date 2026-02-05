import { createClient } from '@supabase/supabase-js';

// Vercel Cron Job - 예약 기도 실행
// 매 5분마다 실행되어 예정된 기도를 처리합니다

export const config = {
  maxDuration: 30, // 최대 30초
};

export default async function handler(req, res) {
  // Cron secret 검증
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. 오늘의 기도 슬롯 생성 (아직 없는 경우)
    const { error: genError } = await supabase.rpc('generate_daily_prayer_slots');
    if (genError) {
      console.error('Error generating slots:', genError);
    }

    // 2. 현재 시간 이전의 pending 슬롯 찾기
    const now = new Date().toISOString();
    const { data: pendingSlots, error: fetchError } = await supabase
      .from('daily_prayer_slots')
      .select(`
        *,
        prayer_schedules (
          prayer_source,
          saved_prayer_ids,
          default_topic,
          user_id
        )
      `)
      .eq('status', 'pending')
      .lte('scheduled_time', now)
      .order('scheduled_time')
      .limit(20);

    if (fetchError) {
      console.error('Error fetching pending slots:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch pending slots' });
    }

    if (!pendingSlots || pendingSlots.length === 0) {
      return res.json({ message: 'No pending prayers', count: 0 });
    }

    let executedCount = 0;

    for (const slot of pendingSlots) {
      try {
        // 상태를 executing으로 변경
        await supabase
          .from('daily_prayer_slots')
          .update({ status: 'executing' })
          .eq('id', slot.id);

        let prayerTitle = '오늘의 기도';
        let prayerContent = '';
        let prayerId = null;
        let source = 'generated';

        const schedule = slot.prayer_schedules;

        // 저장된 기도문에서 선택
        if (
          schedule.prayer_source !== 'generate' &&
          schedule.saved_prayer_ids?.length > 0
        ) {
          const randomIdx = Math.floor(Math.random() * schedule.saved_prayer_ids.length);
          const selectedPrayerId = schedule.saved_prayer_ids[randomIdx];

          const { data: prayer } = await supabase
            .from('prayers')
            .select('id, title, content')
            .eq('id', selectedPrayerId)
            .single();

          if (prayer) {
            prayerId = prayer.id;
            prayerTitle = prayer.title;
            prayerContent = prayer.content;
            source = 'saved';
          }
        }

        // 저장된 기도문이 없으면 간단한 기도문 생성
        if (!prayerContent) {
          const topic = schedule.default_topic || '일상의 평안';
          prayerContent = generateSimplePrayer(topic);
          prayerTitle = `${topic}을 위한 기도`;
          source = 'generated';
        }

        // 기도 실행 로그 생성
        const { data: execution, error: insertError } = await supabase
          .from('prayer_executions')
          .insert({
            schedule_id: slot.schedule_id,
            user_id: slot.user_id,
            scheduled_time: slot.scheduled_time,
            prayer_id: prayerId,
            prayer_title: prayerTitle,
            prayer_content: prayerContent,
            prayer_source: source,
            status: 'completed'
          })
          .select()
          .single();

        if (insertError) {
          console.error('Error inserting execution:', insertError);
          continue;
        }

        // 슬롯 완료 처리
        await supabase
          .from('daily_prayer_slots')
          .update({
            status: 'completed',
            execution_id: execution.id
          })
          .eq('id', slot.id);

        executedCount++;
      } catch (slotError) {
        console.error(`Error processing slot ${slot.id}:`, slotError);

        // 실패 처리
        await supabase
          .from('daily_prayer_slots')
          .update({ status: 'skipped' })
          .eq('id', slot.id);
      }
    }

    return res.json({
      message: `Executed ${executedCount} prayers`,
      count: executedCount,
      total: pendingSlots.length
    });

  } catch (error) {
    console.error('Cron job error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * API 호출 없이 간단한 기도문 생성 (비용 절감)
 */
function generateSimplePrayer(topic) {
  const templates = [
    `하나님, 오늘도 ${topic}을(를) 위해 기도드립니다.\n\n이 기도를 올리는 사람의 마음에 평안을 주시고, 하루하루 은혜 가운데 살아갈 수 있도록 인도해 주세요.\n\n힘들고 지칠 때에도 주님의 사랑을 느낄 수 있게 하시고, 감사한 마음으로 하루를 보낼 수 있게 해주세요.\n\n예수님의 이름으로 기도합니다. 아멘.`,

    `사랑의 하나님,\n\n${topic}에 대해 간절히 기도합니다.\n\n주님의 뜻 안에서 모든 것이 이루어지기를 소망하며, 오늘 하루도 감사와 기쁨으로 채워주시길 바랍니다.\n\n어려운 순간에도 주님이 함께 하심을 믿으며, 담대한 마음을 주세요.\n\n예수님의 이름으로 기도드립니다. 아멘.`,

    `은혜로우신 하나님,\n\n${topic}을(를) 주님의 손에 맡깁니다.\n\n오늘도 주님의 사랑과 보호 아래 안전하게 지켜주시고, 마음에 평화를 부어주세요.\n\n주님이 예비하신 좋은 것들을 기대하며, 하나님의 인도하심을 따르겠습니다.\n\n감사드리며, 예수님의 이름으로 기도합니다. 아멘.`,

    `전능하신 하나님,\n\n${topic}을(를) 위해 주님 앞에 나아갑니다.\n\n주님의 지혜와 사랑으로 인도해 주시고, 필요한 모든 것을 채워주시길 기도합니다.\n\n오늘 하루도 주님의 은혜 안에서 기쁨과 감사로 살아갈 수 있게 해주세요.\n\n주님을 신뢰하며, 예수님의 이름으로 기도합니다. 아멘.`
  ];

  return templates[Math.floor(Math.random() * templates.length)];
}
