import { useNavigate } from 'react-router-dom';
import './UpgradeBanner.css';

export function UpgradeBanner({ profile, rateLimitInfo }) {
  const navigate = useNavigate();

  // Don't show for premium users
  if (profile?.subscription_tier === 'premium') {
    return null;
  }

  // Don't show if not authenticated
  if (!profile) {
    return null;
  }

  // Show upgrade prompt when user is getting close to limit
  const shouldShow = rateLimitInfo && rateLimitInfo.remaining <= 3 && rateLimitInfo.tier === 'free';

  if (!shouldShow) {
    return null;
  }

  return (
    <div className="upgrade-banner">
      <div className="upgrade-content">
        <div className="upgrade-icon">⭐</div>
        <div className="upgrade-text">
          <h4>프리미엄으로 업그레이드하세요!</h4>
          <p>
            무제한 기도문 생성, PDF 다운로드, 음성 낭독, 광고 제거
          </p>
        </div>
        <button
          className="upgrade-button"
          onClick={() => navigate('/pricing')}
        >
          프리미엄 시작하기
        </button>
      </div>
    </div>
  );
}
