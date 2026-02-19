import { createClient } from '@supabase/supabase-js';

// Vercel Cron Job - 예약 기도 실행
// 매일 실행되어 당일 예정된 기도를 처리합니다

export const config = {
  maxDuration: 60, // 최대 60초 (여러 기도 처리)
};

export default async function handler(req, res) {
  // Cron secret 검증
  // Vercel Cron은 Authorization 헤더 없이 호출하므로 x-vercel-cron 헤더도 허용
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasValidSecret =
    req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

  if (!isVercelCron && !hasValidSecret) {
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

        // 저장된 기도문이 없으면 Gemini API로 기도문 생성
        if (!prayerContent) {
          const topic = schedule.default_topic || '일상의 평안';
          const generated = await generatePrayerWithAI(topic);
          prayerContent = generated.content;
          prayerTitle = generated.title;
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
 * Gemini API로 AI 기도문 생성
 * 실패 시 폴백 템플릿 사용
 */
async function generatePrayerWithAI(topic) {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (apiKey) {
    try {
      const prompt = `사용자의 기도 제목: "${topic}"

위 주제로 따뜻하고 위로가 되는 기독교 기도문을 작성하세요.

- 제목: 기도문의 주제를 담은 짧은 제목
- 본문: 300~500자 내외의 기도문. 정중한 경어체를 사용합니다. 마지막에 "예수님의 이름으로 기도드립니다. 아멘."으로 끝맺습니다.

JSON 형식으로 응답하세요. 줄바꿈은 실제 줄바꿈 문자가 아닌 \\n으로 표현하세요.`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 1024,
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  content: { type: 'string' }
                },
                required: ['title', 'content']
              }
            }
          })
        }
      );

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = JSON.parse(text);
        if (parsed.title && parsed.content) {
          return parsed;
        }
      }
    } catch (err) {
      console.error('Gemini API error in cron, using fallback:', err.message);
    }
  }

  // 폴백: Gemini 실패 시 템플릿 사용
  const fallbacks = [
    `하나님, 오늘도 ${topic}을(를) 위해 기도드립니다.\n\n이 기도를 올리는 사람의 마음에 평안을 주시고, 하루하루 은혜 가운데 살아갈 수 있도록 인도해 주세요.\n\n힘들고 지칠 때에도 주님의 사랑을 느낄 수 있게 하시고, 감사한 마음으로 하루를 보낼 수 있게 해주세요.\n\n예수님의 이름으로 기도합니다. 아멘.`,

    `사랑의 하나님,\n\n${topic}에 대해 간절히 기도합니다.\n\n주님의 뜻 안에서 모든 것이 이루어지기를 소망하며, 오늘 하루도 감사와 기쁨으로 채워주시길 바랍니다.\n\n예수님의 이름으로 기도드립니다. 아멘.`,
  ];

  return {
    title: `${topic}을 위한 기도`,
    content: fallbacks[Math.floor(Math.random() * fallbacks.length)]
  };
}
