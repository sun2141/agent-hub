import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './DonateButton.css';

export function DonateButton({ onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const { user } = useAuth();

  const donationAmounts = [
    { amount: 3000, label: '₩3,000', description: '커피 한 잔' },
    { amount: 5000, label: '₩5,000', description: '커피 두 잔' },
    { amount: 10000, label: '₩10,000', description: '브런치 한 끼' },
  ];

  const handleDonate = async (amount) => {
    setLoading(true);

    try {
      const response = await fetch('/api/stripe/create-donation-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount,
          userId: user?.id || null,
          userEmail: user?.email || null,
        }),
      });

      if (!response.ok) {
        throw new Error('결제 세션 생성에 실패했습니다.');
      }

      const { url } = await response.json();
      window.location.href = url;
    } catch (error) {
      console.error('Donation error:', error);
      alert('결제 처리 중 오류가 발생했습니다.\n\n현재 결제 시스템 설정 중입니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        className="donate-trigger-btn"
        onClick={() => setShowModal(true)}
        disabled={loading}
      >
        ☕ 후원하기
      </button>

      {showModal && (
        <div className="donate-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="donate-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="donate-modal-close"
              onClick={() => setShowModal(false)}
            >
              ✕
            </button>

            <h3>Grace-AI 후원하기</h3>
            <p className="donate-description">
              Grace-AI가 도움이 되셨다면, 커피 한 잔으로 응원해주세요! 💝
              <br />
              더 나은 서비스를 제공하는 데 큰 힘이 됩니다.
            </p>

            <div className="donation-options">
              {donationAmounts.map(({ amount, label, description }) => (
                <button
                  key={amount}
                  className="donation-option"
                  onClick={() => handleDonate(amount)}
                  disabled={loading}
                >
                  <div className="donation-amount">{label}</div>
                  <div className="donation-desc">{description}</div>
                </button>
              ))}
            </div>

            <div className="donation-footer">
              <p>💳 안전한 Stripe 결제</p>
              <p className="donation-note">
                * 후원은 100% 서비스 개선과 운영에 사용됩니다
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
