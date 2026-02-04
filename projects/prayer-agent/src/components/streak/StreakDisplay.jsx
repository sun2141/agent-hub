import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './StreakDisplay.css';

const STREAK_MILESTONES = [
  { days: 3, icon: '🔥', label: '3일 연속', color: '#f97316' },
  { days: 7, icon: '⭐', label: '1주일!', color: '#eab308' },
  { days: 14, icon: '💫', label: '2주 달성!', color: '#a855f7' },
  { days: 30, icon: '🏆', label: '한 달!', color: '#10b981' },
  { days: 100, icon: '👑', label: '100일!', color: '#ef4444' },
];

export function StreakDisplay({ compact = false }) {
  const { profile } = useAuth();
  const [showCelebration, setShowCelebration] = useState(false);
  const [milestone, setMilestone] = useState(null);

  const currentStreak = profile?.current_streak || 0;
  const longestStreak = profile?.longest_streak || 0;
  const totalDays = profile?.total_prayer_days || 0;

  useEffect(() => {
    // Check if current streak hit a milestone
    const hitMilestone = STREAK_MILESTONES.find(m => m.days === currentStreak);
    if (hitMilestone) {
      setMilestone(hitMilestone);
      setShowCelebration(true);
      setTimeout(() => setShowCelebration(false), 5000);
    }
  }, [currentStreak]);

  const getStreakIcon = () => {
    if (currentStreak === 0) return '🌱';
    if (currentStreak < 3) return '🔥';
    if (currentStreak < 7) return '⭐';
    if (currentStreak < 14) return '💫';
    if (currentStreak < 30) return '🏆';
    return '👑';
  };

  const getStreakColor = () => {
    if (currentStreak === 0) return '#94a3b8';
    if (currentStreak < 3) return '#f97316';
    if (currentStreak < 7) return '#eab308';
    if (currentStreak < 14) return '#a855f7';
    if (currentStreak < 30) return '#10b981';
    return '#ef4444';
  };

  const getNextMilestone = () => {
    return STREAK_MILESTONES.find(m => m.days > currentStreak) || null;
  };

  const nextMilestone = getNextMilestone();

  if (compact) {
    return (
      <div className="streak-compact" style={{ borderColor: getStreakColor() }}>
        <span className="streak-icon">{getStreakIcon()}</span>
        <span className="streak-number">{currentStreak}</span>
      </div>
    );
  }

  return (
    <div className="streak-container">
      {/* Main Streak Display */}
      <div className="streak-main" style={{ borderColor: getStreakColor() }}>
        <div className="streak-icon-large">{getStreakIcon()}</div>
        <div className="streak-content">
          <div className="streak-label">연속 기도</div>
          <div className="streak-number-large" style={{ color: getStreakColor() }}>
            {currentStreak}
            <span className="streak-unit">일</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="streak-stats">
        <div className="streak-stat">
          <div className="stat-label">최장 기록</div>
          <div className="stat-value">{longestStreak}일</div>
        </div>
        <div className="streak-stat">
          <div className="stat-label">총 기도한 날</div>
          <div className="stat-value">{totalDays}일</div>
        </div>
      </div>

      {/* Next Milestone */}
      {nextMilestone && (
        <div className="streak-next-milestone">
          <div className="milestone-progress">
            <div
              className="milestone-progress-bar"
              style={{
                width: `${(currentStreak / nextMilestone.days) * 100}%`,
                backgroundColor: nextMilestone.color
              }}
            />
          </div>
          <div className="milestone-text">
            <span className="milestone-icon">{nextMilestone.icon}</span>
            <span className="milestone-label">
              {nextMilestone.label}까지 {nextMilestone.days - currentStreak}일
            </span>
          </div>
        </div>
      )}

      {/* Celebration Modal */}
      {showCelebration && milestone && (
        <div className="streak-celebration">
          <div className="celebration-content">
            <div className="celebration-icon">{milestone.icon}</div>
            <div className="celebration-title">축하합니다!</div>
            <div className="celebration-message">{milestone.label} 달성!</div>
            <div className="celebration-confetti">🎉 🎊 ✨</div>
          </div>
        </div>
      )}

      {/* Encouragement */}
      {currentStreak === 0 && (
        <div className="streak-encouragement">
          <span className="encouragement-icon">💪</span>
          <span className="encouragement-text">
            오늘 기도하고 스트릭을 시작하세요!
          </span>
        </div>
      )}

      {currentStreak > 0 && (
        <div className="streak-motivation">
          <span className="motivation-text">
            내일도 기도하고 {currentStreak + 1}일 스트릭을 달성하세요! 🔥
          </span>
        </div>
      )}
    </div>
  );
}
