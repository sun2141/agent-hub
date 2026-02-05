import { useState } from 'react';
import './PrayerNotification.css';

/**
 * 실시간 기도 알림
 * AI가 기도를 드리면 화면 하단에 알림 표시
 */
export function PrayerNotification({ prayer, onView, onDismiss }) {
  const [expanded, setExpanded] = useState(false);

  if (!prayer) return null;

  return (
    <div className={`prayer-notification ${expanded ? 'expanded' : ''}`}>
      <div className="notification-main" onClick={() => setExpanded(!expanded)}>
        <div className="notification-icon">
          <span className="praying-animation">🙏</span>
        </div>
        <div className="notification-content">
          <p className="notification-title">
            AI가 지금 당신을 위해 기도하고 있습니다
          </p>
          <p className="notification-subtitle">
            {prayer.prayer_title || '오늘의 기도'}
          </p>
        </div>
        <button
          className="notification-close"
          onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
        >
          ×
        </button>
      </div>

      {expanded && (
        <div className="notification-detail">
          <p className="notification-prayer-text">
            {prayer.prayer_content?.substring(0, 200)}
            {prayer.prayer_content?.length > 200 ? '...' : ''}
          </p>
          <button
            className="view-full-btn"
            onClick={() => onView?.(prayer)}
          >
            전체 기도문 보기 →
          </button>
        </div>
      )}

      <div className="notification-progress">
        <div className="progress-bar" />
      </div>
    </div>
  );
}
