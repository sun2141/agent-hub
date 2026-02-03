import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './Pricing.css';

export function Pricing() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const plans = {
    free: {
      name: '무료',
      price: '₩0',
      period: '영구',
      features: [
        '하루 10회 기도문 생성',
        '기도문 저장 및 관리',
        '감정별 필터링',
        '검색 기능',
        '모바일 앱 지원'
      ],
      limitations: [
        '광고 표시',
        'PDF 다운로드 불가',
        '음성 낭독 불가'
      ],
      cta: '현재 플랜',
      current: true
    },
    premium: {
      name: '프리미엄',
      price: '₩4,900',
      period: '월',
      popular: true,
      features: [
        '무제한 기도문 생성',
        '모든 무료 플랜 기능',
        'PDF 다운로드',
        '음성 낭독 (TTS)',
        '광고 제거',
        '우선 고객 지원',
        '새 기능 먼저 체험'
      ],
      cta: user ? (profile?.subscription_tier === 'premium' ? '현재 플랜' : '프리미엄 시작하기') : '로그인 필요',
      current: profile?.subscription_tier === 'premium'
    }
  };

  const handleUpgrade = async () => {
    if (!user) {
      navigate('/?login=true');
      return;
    }

    if (profile?.subscription_tier === 'premium') {
      // Open customer portal
      await handleManageSubscription();
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: user.id,
          userEmail: user.email
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create checkout session');
      }

      const { url } = await response.json();

      // Redirect to Stripe Checkout
      window.location.href = url;
    } catch (err) {
      console.error('Checkout error:', err);
      setError('결제 페이지 로딩 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      setLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    if (!user || !profile?.subscription_tier === 'premium') {
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Get customer ID from Supabase subscriptions table
      const response = await fetch('/api/stripe/create-portal-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customerId: user.stripe_customer_id // You'll need to store this
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create portal session');
      }

      const { url } = await response.json();
      window.location.href = url;
    } catch (err) {
      console.error('Portal error:', err);
      setError('구독 관리 페이지 로딩 중 오류가 발생했습니다.');
      setLoading(false);
    }
  };

  return (
    <div className="pricing-page">
      <button className="back-button" onClick={() => navigate('/')}>
        ← 돌아가기
      </button>

      <div className="pricing-header">
        <h1>요금제</h1>
        <p className="subtitle">
          Grace-AI와 함께 더 깊은 기도 생활을 시작하세요
        </p>
      </div>

      {error && (
        <div className="pricing-error">
          {error}
        </div>
      )}

      <div className="pricing-cards">
        {/* Free Plan */}
        <div className="pricing-card">
          <div className="plan-header">
            <h3>{plans.free.name}</h3>
            <div className="plan-price">
              <span className="price">{plans.free.price}</span>
              <span className="period">/ {plans.free.period}</span>
            </div>
          </div>

          <ul className="plan-features">
            {plans.free.features.map((feature, i) => (
              <li key={i} className="feature-item">
                <span className="feature-icon">✓</span>
                {feature}
              </li>
            ))}
            {plans.free.limitations.map((limitation, i) => (
              <li key={`lim-${i}`} className="feature-item limited">
                <span className="feature-icon">✗</span>
                {limitation}
              </li>
            ))}
          </ul>

          <button
            className="plan-cta disabled"
            disabled
          >
            {plans.free.cta}
          </button>
        </div>

        {/* Premium Plan */}
        <div className={`pricing-card ${plans.premium.popular ? 'popular' : ''}`}>
          {plans.premium.popular && (
            <div className="popular-badge">가장 인기</div>
          )}

          <div className="plan-header">
            <h3>{plans.premium.name}</h3>
            <div className="plan-price">
              <span className="price">{plans.premium.price}</span>
              <span className="period">/ {plans.premium.period}</span>
            </div>
          </div>

          <ul className="plan-features">
            {plans.premium.features.map((feature, i) => (
              <li key={i} className="feature-item">
                <span className="feature-icon">✓</span>
                {feature}
              </li>
            ))}
          </ul>

          <button
            className={`plan-cta ${plans.premium.current ? 'current' : 'primary'}`}
            onClick={handleUpgrade}
            disabled={loading || plans.premium.current}
          >
            {loading ? '처리 중...' : plans.premium.cta}
          </button>

          {profile?.subscription_tier === 'premium' && (
            <button
              className="manage-subscription"
              onClick={handleManageSubscription}
              disabled={loading}
            >
              구독 관리
            </button>
          )}
        </div>
      </div>

      {/* FAQ Section */}
      <div className="pricing-faq">
        <h2>자주 묻는 질문</h2>

        <div className="faq-item">
          <h4>결제 방법은 무엇인가요?</h4>
          <p>
            신용카드 및 체크카드로 결제하실 수 있습니다.
            모든 결제는 Stripe를 통해 안전하게 처리됩니다.
          </p>
        </div>

        <div className="faq-item">
          <h4>언제든지 취소할 수 있나요?</h4>
          <p>
            네, 언제든지 취소하실 수 있습니다.
            취소 후에도 결제한 기간이 끝날 때까지 프리미엄 기능을 사용하실 수 있습니다.
          </p>
        </div>

        <div className="faq-item">
          <h4>환불이 가능한가요?</h4>
          <p>
            첫 결제 후 7일 이내에는 전액 환불이 가능합니다.
            고객센터로 문의해주세요.
          </p>
        </div>

        <div className="faq-item">
          <h4>프리미엄 기능은 언제 사용할 수 있나요?</h4>
          <p>
            결제 완료 즉시 모든 프리미엄 기능을 사용하실 수 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
}
