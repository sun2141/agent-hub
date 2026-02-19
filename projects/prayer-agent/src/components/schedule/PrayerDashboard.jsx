import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getTodayPrayerSlots,
  getRecentPrayerExecutions,
  getUnviewedPrayers,
  getPrayerStats,
  markPrayerAsViewed
} from '../../lib/supabaseClient';
import { PrayerScheduler } from './PrayerScheduler';
import './PrayerDashboard.css';

export function PrayerDashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [showScheduler, setShowScheduler] = useState(false);
  const [todaySlots, setTodaySlots] = useState([]);
  const [recentPrayers, setRecentPrayers] = useState([]);
  const [unviewedPrayers, setUnviewedPrayers] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedPrayer, setSelectedPrayer] = useState(null);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    setLoading(true);
    const [slotsRes, prayersRes, unviewedRes, statsRes] = await Promise.all([
      getTodayPrayerSlots(user.id),
      getRecentPrayerExecutions(user.id, 10),
      getUnviewedPrayers(user.id),
      getPrayerStats(user.id)
    ]);

    setTodaySlots(slotsRes.data);
    setRecentPrayers(prayersRes.data);
    setUnviewedPrayers(unviewedRes.data);
    setStats(statsRes);
    setLoading(false);
  };

  const handleViewPrayer = async (prayer) => {
    setSelectedPrayer(prayer);
    if (!prayer.user_viewed) {
      await markPrayerAsViewed(prayer.id);
      setUnviewedPrayers(unviewedPrayers.filter(p => p.id !== prayer.id));
    }
  };

  const formatTime = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  };

  const getSlotStatus = (slot) => {
    const now = new Date();
    const slotTime = new Date(slot.scheduled_time);

    if (slot.status === 'completed') {
      return { label: '완료', className: 'completed', icon: '✓' };
    } else if (slot.status === 'executing') {
      return { label: '기도 중', className: 'executing', icon: '🙏' };
    } else if (slotTime <= now) {
      return { label: '대기 중', className: 'waiting', icon: '⏳' };
    } else {
      return { label: '예정', className: 'pending', icon: '⏰' };
    }
  };

  const getNextPrayerTime = () => {
    const pendingSlots = todaySlots.filter(s => s.status === 'pending');
    if (pendingSlots.length === 0) return null;

    const nextSlot = pendingSlots.sort((a, b) =>
      new Date(a.scheduled_time) - new Date(b.scheduled_time)
    )[0];

    return formatTime(nextSlot.scheduled_time);
  };

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>기도 현황을 불러오는 중...</p>
      </div>
    );
  }

  return (
    <div className="prayer-dashboard">
      {/* 헤더 */}
      <div className="dashboard-header">
        <div className="header-content">
          <h2>🙏 AI에게 기도 맡기기</h2>
          <p>AI가 매일 정해진 시간에 당신을 위해 기도합니다</p>
        </div>
        <button className="settings-btn" onClick={() => setShowScheduler(true)}>
          ⚙️ 설정
        </button>
      </div>

      {/* 확인하지 않은 기도 알림 */}
      {unviewedPrayers.length > 0 && (
        <div className="unviewed-alert" onClick={() => handleViewPrayer(unviewedPrayers[0])}>
          <span className="alert-icon">✨</span>
          <span className="alert-text">
            AI가 {unviewedPrayers.length}개의 기도를 드렸습니다
          </span>
          <span className="alert-action">확인하기 →</span>
        </div>
      )}

      {/* 통계 카드 */}
      {stats && (
        <div className="stats-row">
          <div className="stat-card">
            <span className="stat-icon">📿</span>
            <span className="stat-value">{stats.scheduledPrayersTotal}</span>
            <span className="stat-label">받은 기도</span>
          </div>
          <div className="stat-card">
            <span className="stat-icon">🔥</span>
            <span className="stat-value">{stats.currentStreak}일</span>
            <span className="stat-label">연속 기도</span>
          </div>
          <div className="stat-card">
            <span className="stat-icon">⭐</span>
            <span className="stat-value">{stats.longestStreak}일</span>
            <span className="stat-label">최장 기록</span>
          </div>
        </div>
      )}

      {/* 오늘의 기도 일정 */}
      <div className="section">
        <div className="section-header">
          <h3>오늘의 기도</h3>
          {getNextPrayerTime() && (
            <span className="next-prayer">다음: {getNextPrayerTime()}</span>
          )}
        </div>

        {todaySlots.length > 0 ? (
          <div className="today-slots">
            {todaySlots.map(slot => {
              const status = getSlotStatus(slot);
              return (
                <div
                  key={slot.id}
                  className={`slot-item ${status.className}`}
                  onClick={() => slot.prayer_executions?.[0] && handleViewPrayer(slot.prayer_executions[0])}
                >
                  <span className="slot-time">{formatTime(slot.scheduled_time)}</span>
                  <span className={`slot-status ${status.className}`}>
                    {status.icon} {status.label}
                  </span>
                  {slot.prayer_executions?.[0]?.prayer_title && (
                    <span className="slot-title">{slot.prayer_executions[0].prayer_title}</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <p>오늘 예정된 기도가 없습니다</p>
            <button onClick={() => setShowScheduler(true)}>
              ⏰ 기도 시간 설정하기
            </button>
          </div>
        )}
      </div>

      {/* 최근 기도 히스토리 */}
      <div className="section">
        <h3>최근 받은 기도</h3>
        {recentPrayers.length > 0 ? (
          <div className="prayer-history">
            {recentPrayers.map(prayer => (
              <div
                key={prayer.id}
                className={`history-item ${!prayer.user_viewed ? 'unviewed' : ''}`}
                onClick={() => handleViewPrayer(prayer)}
              >
                <div className="history-meta">
                  <span className="history-date">{formatDate(prayer.executed_at)}</span>
                  <span className="history-time">{formatTime(prayer.executed_at)}</span>
                </div>
                <span className="history-title">{prayer.prayer_title}</span>
                {!prayer.user_viewed && <span className="new-badge">NEW</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p>아직 받은 기도가 없습니다</p>
          </div>
        )}
      </div>

      {/* 기도 상세 보기 모달 */}
      {selectedPrayer && (
        <div className="prayer-modal-overlay" onClick={() => setSelectedPrayer(null)}>
          <div className="prayer-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedPrayer(null)}>×</button>

            <div className="modal-header">
              <span className="modal-icon">🙏</span>
              <h3>{selectedPrayer.prayer_title || '오늘의 기도'}</h3>
              <p className="modal-time">
                {formatDate(selectedPrayer.executed_at)} {formatTime(selectedPrayer.executed_at)}
              </p>
            </div>

            <div className="modal-content">
              <p className="prayer-text">{selectedPrayer.prayer_content}</p>
            </div>

            <div className="modal-footer">
              <p className="comfort-message">
                ✨ AI가 당신을 위해 이 기도를 드렸습니다
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 스케줄러 모달 */}
      {showScheduler && (
        <PrayerScheduler
          onClose={() => setShowScheduler(false)}
          onSave={() => {
            setShowScheduler(false);
            loadData();
          }}
        />
      )}
    </div>
  );
}
