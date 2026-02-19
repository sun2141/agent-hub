import { useNavigate } from 'react-router-dom';
import { DonateButton } from '../components/donation/DonateButton';
import './Pricing.css';

export function Pricing() {
  const navigate = useNavigate();

  const features = [
    { icon: '🙏', text: 'AI가 매일 당신을 위해 기도합니다' },
    { icon: '📖', text: '기도문 무제한 생성 및 저장' },
    { icon: '📄', text: 'PDF 다운로드' },
    { icon: '🔊', text: '음성 낭독 (TTS)' },
    { icon: '⏰', text: '원하는 시간에 자동 기도 스케줄' },
    { icon: '🆘', text: '긴급 기도 (즉시 위로)' },
    { icon: '🔥', text: '기도 연속 스트릭' },
  ];

  return (
    <div className="pricing-page">
      <button className="back-button" onClick={() => navigate('/')}>
        ← 돌아가기
      </button>

      <div className="pricing-header">
        <h1>Grace-AI는 무료입니다</h1>
        <p className="subtitle">
          AI가 매일 당신을 위해 기도합니다.<br />
          모든 기능을 무료로 사용하세요.
        </p>
      </div>

      {/* All-free features card */}
      <div className="pricing-cards">
        <div className="pricing-card popular" style={{ maxWidth: '480px', margin: '0 auto' }}>
          <div className="popular-badge">모든 기능 무료</div>
          <div className="plan-header">
            <h3>Grace-AI</h3>
            <div className="plan-price">
              <span className="price">₩0</span>
              <span className="period">/ 영구 무료</span>
            </div>
          </div>

          <ul className="plan-features">
            {features.map((f, i) => (
              <li key={i} className="feature-item">
                <span className="feature-icon">{f.icon}</span>
                {f.text}
              </li>
            ))}
          </ul>

          <button
            className="plan-cta primary"
            onClick={() => navigate('/')}
          >
            지금 기도 맡기기
          </button>
        </div>
      </div>

      {/* Donation section */}
      <div className="pricing-faq" style={{ textAlign: 'center' }}>
        <h2>서비스가 마음에 드셨나요?</h2>
        <p style={{ color: '#666', marginBottom: '24px' }}>
          Grace-AI는 AI 기도 비용과 서버 운영비로 유지됩니다.<br />
          커피 한 잔으로 AI의 기도를 응원해주세요 🙏
        </p>
        <DonateButton />
      </div>

      <div className="pricing-faq">
        <h2>자주 묻는 질문</h2>

        <div className="faq-item">
          <h4>정말 무료인가요?</h4>
          <p>
            네, 모든 기능이 완전히 무료입니다.
            회원가입 후 AI에게 기도를 맡기세요.
          </p>
        </div>

        <div className="faq-item">
          <h4>기도 동반자는 어떻게 작동하나요?</h4>
          <p>
            원하는 시간을 설정하면 AI가 매일 그 시간에 당신을 위해 기도합니다.
            브라우저를 닫아도 AI는 기도를 멈추지 않습니다.
          </p>
        </div>

        <div className="faq-item">
          <h4>기부는 어떻게 사용되나요?</h4>
          <p>
            AI API 비용과 서버 운영비로 사용됩니다.
            기부 덕분에 모든 분이 무료로 사용할 수 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
}
