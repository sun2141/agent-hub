-- =============================================
-- 예약 기도 시스템 (Scheduled Prayer System)
-- AI가 사용자 대신 기도하는 기능
-- =============================================

-- 예약 기도 설정 테이블
CREATE TABLE IF NOT EXISTS prayer_schedules (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    -- 스케줄 설정
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('fixed', 'random')),
    -- fixed: 고정 시간, random: 하루 중 랜덤

    -- 고정 시간 설정 (schedule_type = 'fixed')
    fixed_times TIME[] DEFAULT '{}',  -- 예: {'07:00', '12:00', '21:00'}

    -- 랜덤 설정 (schedule_type = 'random')
    random_count INTEGER DEFAULT 3,  -- 하루 몇 번
    random_start_time TIME DEFAULT '06:00',  -- 랜덤 시작 시간
    random_end_time TIME DEFAULT '22:00',    -- 랜덤 종료 시간

    -- 기도 내용 설정
    prayer_source TEXT NOT NULL CHECK (prayer_source IN ('saved', 'generate', 'mixed')),
    -- saved: 저장된 기도문 사용, generate: 새로 생성, mixed: 혼합

    saved_prayer_ids UUID[] DEFAULT '{}',  -- 저장된 기도문 ID 목록
    default_topic TEXT DEFAULT '',          -- 새 기도문 생성시 기본 주제

    -- 알림 설정
    notify_before BOOLEAN DEFAULT true,     -- 기도 전 알림
    notify_after BOOLEAN DEFAULT true,      -- 기도 완료 알림

    -- 활성화 여부
    is_active BOOLEAN DEFAULT true,
    timezone TEXT DEFAULT 'Asia/Seoul',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 예약 기도 실행 로그 테이블
CREATE TABLE IF NOT EXISTS prayer_executions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    schedule_id UUID REFERENCES prayer_schedules(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    -- 실행 정보
    scheduled_time TIMESTAMPTZ NOT NULL,     -- 예정 시간
    executed_at TIMESTAMPTZ DEFAULT NOW(),   -- 실제 실행 시간

    -- 기도 내용
    prayer_id UUID REFERENCES prayers(id) ON DELETE SET NULL,  -- 사용된 기도문
    prayer_title TEXT,
    prayer_content TEXT,
    prayer_source TEXT CHECK (prayer_source IN ('saved', 'generated')),

    -- 상태
    status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
    error_message TEXT,

    -- 사용자 확인
    user_viewed BOOLEAN DEFAULT false,
    viewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 오늘의 기도 일정 (매일 생성되는 실제 시간표)
CREATE TABLE IF NOT EXISTS daily_prayer_slots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    schedule_id UUID REFERENCES prayer_schedules(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    date DATE NOT NULL,                      -- 날짜
    scheduled_time TIMESTAMPTZ NOT NULL,     -- 예정 시간

    -- 상태
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'skipped')),
    execution_id UUID REFERENCES prayer_executions(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(schedule_id, date, scheduled_time)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_prayer_schedules_user ON prayer_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_prayer_schedules_active ON prayer_schedules(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_prayer_executions_user ON prayer_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_prayer_executions_schedule ON prayer_executions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_prayer_executions_date ON prayer_executions(executed_at);
CREATE INDEX IF NOT EXISTS idx_prayer_executions_unviewed ON prayer_executions(user_id, user_viewed) WHERE user_viewed = false;

CREATE INDEX IF NOT EXISTS idx_daily_slots_user_date ON daily_prayer_slots(user_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_slots_pending ON daily_prayer_slots(scheduled_time, status) WHERE status = 'pending';

-- RLS 정책
ALTER TABLE prayer_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE prayer_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_prayer_slots ENABLE ROW LEVEL SECURITY;

-- 사용자는 자신의 데이터만 접근 가능
CREATE POLICY "Users can manage their own schedules"
    ON prayer_schedules FOR ALL
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own executions"
    ON prayer_executions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own executions"
    ON prayer_executions FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own daily slots"
    ON daily_prayer_slots FOR ALL
    USING (auth.uid() = user_id);

-- 서비스 역할은 모든 접근 가능 (cron job용)
CREATE POLICY "Service role full access to schedules"
    ON prayer_schedules FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to executions"
    ON prayer_executions FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to slots"
    ON daily_prayer_slots FOR ALL
    USING (auth.role() = 'service_role');

-- 일일 기도 슬롯 생성 함수
CREATE OR REPLACE FUNCTION generate_daily_prayer_slots()
RETURNS void AS $$
DECLARE
    schedule RECORD;
    slot_time TIMESTAMPTZ;
    random_times TIMESTAMPTZ[];
    i INTEGER;
    today DATE := CURRENT_DATE;
BEGIN
    -- 활성화된 모든 스케줄에 대해
    FOR schedule IN
        SELECT * FROM prayer_schedules
        WHERE is_active = true
        AND NOT EXISTS (
            SELECT 1 FROM daily_prayer_slots
            WHERE schedule_id = prayer_schedules.id
            AND date = today
        )
    LOOP
        IF schedule.schedule_type = 'fixed' THEN
            -- 고정 시간 스케줄
            FOREACH slot_time IN ARRAY schedule.fixed_times
            LOOP
                INSERT INTO daily_prayer_slots (schedule_id, user_id, date, scheduled_time)
                VALUES (
                    schedule.id,
                    schedule.user_id,
                    today,
                    (today || ' ' || slot_time)::TIMESTAMPTZ AT TIME ZONE schedule.timezone
                )
                ON CONFLICT DO NOTHING;
            END LOOP;
        ELSE
            -- 랜덤 시간 스케줄
            FOR i IN 1..schedule.random_count
            LOOP
                -- 시작~종료 시간 사이에서 랜덤 선택
                slot_time := (today || ' ' || schedule.random_start_time)::TIMESTAMPTZ AT TIME ZONE schedule.timezone
                    + (random() * (
                        EXTRACT(EPOCH FROM (schedule.random_end_time - schedule.random_start_time))
                    ))::INTEGER * INTERVAL '1 second';

                INSERT INTO daily_prayer_slots (schedule_id, user_id, date, scheduled_time)
                VALUES (schedule.id, schedule.user_id, today, slot_time)
                ON CONFLICT DO NOTHING;
            END LOOP;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 기도 실행 함수 (cron에서 호출)
CREATE OR REPLACE FUNCTION execute_pending_prayers()
RETURNS INTEGER AS $$
DECLARE
    slot RECORD;
    prayer RECORD;
    execution_id UUID;
    executed_count INTEGER := 0;
BEGIN
    -- 현재 시간 이전의 pending 슬롯 찾기
    FOR slot IN
        SELECT dps.*, ps.prayer_source, ps.saved_prayer_ids, ps.default_topic
        FROM daily_prayer_slots dps
        JOIN prayer_schedules ps ON dps.schedule_id = ps.id
        WHERE dps.status = 'pending'
        AND dps.scheduled_time <= NOW()
        ORDER BY dps.scheduled_time
        LIMIT 10  -- 한 번에 10개씩 처리
    LOOP
        -- 상태를 executing으로 변경
        UPDATE daily_prayer_slots SET status = 'executing' WHERE id = slot.id;

        -- 저장된 기도문 선택 또는 새로 생성
        IF slot.prayer_source = 'saved' AND array_length(slot.saved_prayer_ids, 1) > 0 THEN
            -- 저장된 기도문에서 랜덤 선택
            SELECT * INTO prayer
            FROM prayers
            WHERE id = slot.saved_prayer_ids[1 + floor(random() * array_length(slot.saved_prayer_ids, 1))::INTEGER];
        END IF;

        -- 기도 실행 로그 생성
        INSERT INTO prayer_executions (
            schedule_id, user_id, scheduled_time,
            prayer_id, prayer_title, prayer_content, prayer_source, status
        )
        VALUES (
            slot.schedule_id, slot.user_id, slot.scheduled_time,
            prayer.id,
            COALESCE(prayer.title, '오늘의 기도'),
            COALESCE(prayer.content, '주님, 오늘 하루도 함께 해주세요.'),
            CASE WHEN prayer.id IS NOT NULL THEN 'saved' ELSE 'generated' END,
            'completed'
        )
        RETURNING id INTO execution_id;

        -- 슬롯 완료 처리
        UPDATE daily_prayer_slots
        SET status = 'completed', execution_id = execution_id
        WHERE id = slot.id;

        executed_count := executed_count + 1;
    END LOOP;

    RETURN executed_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 기도 확인 함수
CREATE OR REPLACE FUNCTION mark_prayer_viewed(execution_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE prayer_executions
    SET user_viewed = true, viewed_at = NOW()
    WHERE id = execution_uuid AND user_id = auth.uid();

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 사용자 기도 통계 뷰
CREATE OR REPLACE VIEW user_prayer_stats AS
SELECT
    user_id,
    COUNT(*) as total_scheduled_prayers,
    COUNT(*) FILTER (WHERE user_viewed = true) as viewed_prayers,
    COUNT(*) FILTER (WHERE user_viewed = false) as unviewed_prayers,
    MAX(executed_at) as last_prayer_time,
    COUNT(DISTINCT DATE(executed_at)) as prayer_days
FROM prayer_executions
WHERE status = 'completed'
GROUP BY user_id;

-- 오늘의 기도 현황 뷰
CREATE OR REPLACE VIEW today_prayer_status AS
SELECT
    dps.user_id,
    dps.date,
    dps.scheduled_time,
    dps.status,
    pe.prayer_title,
    pe.prayer_content,
    pe.user_viewed
FROM daily_prayer_slots dps
LEFT JOIN prayer_executions pe ON dps.execution_id = pe.id
WHERE dps.date = CURRENT_DATE
ORDER BY dps.scheduled_time;
