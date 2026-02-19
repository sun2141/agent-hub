import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getPrayerSchedule,
  savePrayerSchedule,
  getUserPrayers
} from '../../lib/supabaseClient';
import './PrayerScheduler.css';

const TIME_PRESETS = [
  { label: '아침', time: '07:00', icon: '🌅' },
  { label: '점심', time: '12:00', icon: '☀️' },
  { label: '저녁', time: '18:00', icon: '🌆' },
  { label: '밤', time: '21:00', icon: '🌙' },
];

export function PrayerScheduler({ onClose, onSave }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedPrayers, setSavedPrayers] = useState([]);

  // 스케줄 설정
  const [scheduleType, setScheduleType] = useState('fixed'); // fixed | random
  const [selectedTimes, setSelectedTimes] = useState(['07:00', '21:00']);
  const [customTime, setCustomTime] = useState('');

  // 랜덤 설정
  const [randomCount, setRandomCount] = useState(3);
  const [randomStart, setRandomStart] = useState('06:00');
  const [randomEnd, setRandomEnd] = useState('22:00');

  // 기도문 소스
  const [prayerSource, setPrayerSource] = useState('saved'); // saved | generate | mixed
  const [selectedPrayerIds, setSelectedPrayerIds] = useState([]);
  const [defaultTopic, setDefaultTopic] = useState('');

  // 알림 설정
  const [notifyBefore, setNotifyBefore] = useState(true);
  const [notifyAfter, setNotifyAfter] = useState(true);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (user) {
      loadSchedule();
      loadSavedPrayers();
    }
  }, [user]);

  const loadSchedule = async () => {
    const { data } = await getPrayerSchedule(user.id);
    if (data) {
      setScheduleType(data.schedule_type);
      setSelectedTimes(data.fixed_times || []);
      setRandomCount(data.random_count || 3);
      setRandomStart(data.random_start_time || '06:00');
      setRandomEnd(data.random_end_time || '22:00');
      setPrayerSource(data.prayer_source);
      setSelectedPrayerIds(data.saved_prayer_ids || []);
      setDefaultTopic(data.default_topic || '');
      setNotifyBefore(data.notify_before);
      setNotifyAfter(data.notify_after);
      setIsActive(data.is_active);
    }
    setLoading(false);
  };

  const loadSavedPrayers = async () => {
    const { data } = await getUserPrayers(user.id, { limit: 50 });
    setSavedPrayers(data || []);
  };

  const toggleTime = (time) => {
    if (selectedTimes.includes(time)) {
      setSelectedTimes(selectedTimes.filter(t => t !== time));
    } else {
      setSelectedTimes([...selectedTimes, time].sort());
    }
  };

  const addCustomTime = () => {
    if (customTime && !selectedTimes.includes(customTime)) {
      setSelectedTimes([...selectedTimes, customTime].sort());
      setCustomTime('');
    }
  };

  const togglePrayerSelection = (prayerId) => {
    if (selectedPrayerIds.includes(prayerId)) {
      setSelectedPrayerIds(selectedPrayerIds.filter(id => id !== prayerId));
    } else {
      setSelectedPrayerIds([...selectedPrayerIds, prayerId]);
    }
  };

  const handleSave = async () => {
    if (!user) return;

    setSaving(true);
    const scheduleData = {
      schedule_type: scheduleType,
      fixed_times: scheduleType === 'fixed' ? selectedTimes : [],
      random_count: scheduleType === 'random' ? randomCount : 3,
      random_start_time: randomStart,
      random_end_time: randomEnd,
      prayer_source: prayerSource,
      saved_prayer_ids: prayerSource !== 'generate' ? selectedPrayerIds : [],
      default_topic: defaultTopic,
      notify_before: notifyBefore,
      notify_after: notifyAfter,
      is_active: isActive,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    const { error } = await savePrayerSchedule(user.id, scheduleData);
    setSaving(false);

    if (error) {
      alert('저장 중 오류가 발생했습니다: ' + error);
    } else {
      onSave?.();
      onClose?.();
    }
  };

  if (loading) {
    return (
      <div className="scheduler-overlay">
        <div className="scheduler-modal">
          <div className="scheduler-loading">로딩 중...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="scheduler-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="scheduler-modal">
        <button className="scheduler-close" onClick={onClose}>×</button>

        <div className="scheduler-header">
          <h2>⏰ 기도 예약 설정</h2>
          <p>AI가 설정한 시간에 당신을 위해 기도합니다</p>
        </div>

        {/* 활성화 토글 */}
        <div className="scheduler-toggle">
          <label>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span className="toggle-slider"></span>
            <span className="toggle-label">
              {isActive ? '🙏 AI 기도 맡기기 ON' : 'AI 기도 맡기기 OFF'}
            </span>
          </label>
        </div>

        {/* 스케줄 타입 선택 */}
        <div className="scheduler-section">
          <h3>기도 시간</h3>
          <div className="schedule-type-tabs">
            <button
              className={scheduleType === 'fixed' ? 'active' : ''}
              onClick={() => setScheduleType('fixed')}
            >
              ⏱️ 고정 시간
            </button>
            <button
              className={scheduleType === 'random' ? 'active' : ''}
              onClick={() => setScheduleType('random')}
            >
              🎲 랜덤 시간
            </button>
          </div>

          {scheduleType === 'fixed' ? (
            <div className="fixed-time-section">
              <div className="time-presets">
                {TIME_PRESETS.map(preset => (
                  <button
                    key={preset.time}
                    className={`time-preset ${selectedTimes.includes(preset.time) ? 'selected' : ''}`}
                    onClick={() => toggleTime(preset.time)}
                  >
                    <span className="preset-icon">{preset.icon}</span>
                    <span className="preset-label">{preset.label}</span>
                    <span className="preset-time">{preset.time}</span>
                  </button>
                ))}
              </div>

              <div className="custom-time">
                <input
                  type="time"
                  value={customTime}
                  onChange={(e) => setCustomTime(e.target.value)}
                  placeholder="커스텀 시간"
                />
                <button onClick={addCustomTime} disabled={!customTime}>
                  추가
                </button>
              </div>

              {selectedTimes.length > 0 && (
                <div className="selected-times">
                  <span className="label">선택된 시간:</span>
                  {selectedTimes.map(time => (
                    <span key={time} className="time-badge">
                      {time}
                      <button onClick={() => toggleTime(time)}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="random-time-section">
              <div className="random-count">
                <label>하루 기도 횟수</label>
                <div className="count-selector">
                  {[1, 2, 3, 5, 7].map(count => (
                    <button
                      key={count}
                      className={randomCount === count ? 'selected' : ''}
                      onClick={() => setRandomCount(count)}
                    >
                      {count}회
                    </button>
                  ))}
                </div>
              </div>

              <div className="random-range">
                <label>기도 가능 시간대</label>
                <div className="range-inputs">
                  <input
                    type="time"
                    value={randomStart}
                    onChange={(e) => setRandomStart(e.target.value)}
                  />
                  <span>~</span>
                  <input
                    type="time"
                    value={randomEnd}
                    onChange={(e) => setRandomEnd(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 기도문 소스 선택 */}
        <div className="scheduler-section">
          <h3>기도 내용</h3>
          <div className="prayer-source-options">
            <label className={prayerSource === 'saved' ? 'selected' : ''}>
              <input
                type="radio"
                name="prayerSource"
                value="saved"
                checked={prayerSource === 'saved'}
                onChange={(e) => setPrayerSource(e.target.value)}
              />
              <span className="option-icon">📚</span>
              <span className="option-text">
                <strong>저장된 기도문</strong>
                <small>내가 저장한 기도문 사용 (비용 없음)</small>
              </span>
            </label>

            <label className={prayerSource === 'mixed' ? 'selected' : ''}>
              <input
                type="radio"
                name="prayerSource"
                value="mixed"
                checked={prayerSource === 'mixed'}
                onChange={(e) => setPrayerSource(e.target.value)}
              />
              <span className="option-icon">🔀</span>
              <span className="option-text">
                <strong>혼합</strong>
                <small>저장된 기도문 우선, 없으면 새로 생성</small>
              </span>
            </label>

            <label className={prayerSource === 'generate' ? 'selected' : ''}>
              <input
                type="radio"
                name="prayerSource"
                value="generate"
                checked={prayerSource === 'generate'}
                onChange={(e) => setPrayerSource(e.target.value)}
              />
              <span className="option-icon">✨</span>
              <span className="option-text">
                <strong>새 기도문 생성</strong>
                <small>매번 새로운 기도문 (프리미엄)</small>
              </span>
            </label>
          </div>

          {prayerSource !== 'generate' && savedPrayers.length > 0 && (
            <div className="saved-prayers-list">
              <p className="list-hint">사용할 기도문을 선택하세요 (복수 선택 가능)</p>
              {savedPrayers.slice(0, 10).map(prayer => (
                <label
                  key={prayer.id}
                  className={`prayer-item ${selectedPrayerIds.includes(prayer.id) ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPrayerIds.includes(prayer.id)}
                    onChange={() => togglePrayerSelection(prayer.id)}
                  />
                  <span className="prayer-title">{prayer.title}</span>
                  <span className="prayer-preview">
                    {prayer.content?.substring(0, 50)}...
                  </span>
                </label>
              ))}
            </div>
          )}

          {prayerSource !== 'saved' && (
            <div className="default-topic">
              <label>기본 기도 주제 (새 기도문 생성시)</label>
              <input
                type="text"
                value={defaultTopic}
                onChange={(e) => setDefaultTopic(e.target.value)}
                placeholder="예: 가족의 건강과 평안"
              />
            </div>
          )}
        </div>

        {/* 알림 설정 */}
        <div className="scheduler-section notification-section">
          <h3>알림 설정</h3>
          <label>
            <input
              type="checkbox"
              checked={notifyBefore}
              onChange={(e) => setNotifyBefore(e.target.checked)}
            />
            기도 시작 알림
          </label>
          <label>
            <input
              type="checkbox"
              checked={notifyAfter}
              onChange={(e) => setNotifyAfter(e.target.checked)}
            />
            기도 완료 알림
          </label>
        </div>

        {/* 저장 버튼 */}
        <div className="scheduler-actions">
          <button className="cancel-btn" onClick={onClose}>
            취소
          </button>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={saving || (scheduleType === 'fixed' && selectedTimes.length === 0)}
          >
            {saving ? '저장 중...' : '💾 저장하기'}
          </button>
        </div>
      </div>
    </div>
  );
}
