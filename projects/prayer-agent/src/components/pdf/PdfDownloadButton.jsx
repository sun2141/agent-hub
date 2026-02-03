import { useState } from 'react';
import { PDFDownloadLink } from '@react-pdf/renderer';
import { PrayerPdfDocument } from './PrayerPdfDocument';
import { useAuth } from '../../contexts/AuthContext';
import './PdfDownloadButton.css';

export function PdfDownloadButton({ prayer, compact = false }) {
  const { profile } = useAuth();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  const isPremium = profile?.subscription_tier === 'premium';

  const handleClick = (e) => {
    if (!isPremium) {
      e.preventDefault();
      setShowUpgradeModal(true);
    }
  };

  if (!prayer || !prayer.title || !prayer.content) {
    return null;
  }

  const fileName = `${prayer.title.substring(0, 20)}_${new Date(prayer.created_at).toLocaleDateString('ko-KR').replace(/\./g, '')}.pdf`;

  return (
    <>
      {isPremium ? (
        <PDFDownloadLink
          document={<PrayerPdfDocument prayer={prayer} />}
          fileName={fileName}
          className={compact ? 'pdf-download-btn-compact' : 'pdf-download-btn'}
        >
          {({ loading }) =>
            loading ? (
              compact ? '⏳' : '📄 PDF 준비 중...'
            ) : (
              compact ? '📄' : '📄 PDF 다운로드'
            )
          }
        </PDFDownloadLink>
      ) : (
        <button
          className={compact ? 'pdf-download-btn-compact locked' : 'pdf-download-btn locked'}
          onClick={handleClick}
        >
          {compact ? '🔒' : '🔒 PDF 다운로드 (프리미엄)'}
        </button>
      )}

      {showUpgradeModal && (
        <div className="upgrade-modal-overlay" onClick={() => setShowUpgradeModal(false)}>
          <div className="upgrade-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="upgrade-modal-close"
              onClick={() => setShowUpgradeModal(false)}
            >
              ✕
            </button>

            <div className="upgrade-modal-icon">🔒</div>
            <h3>프리미엄 기능입니다</h3>
            <p>
              PDF 다운로드는 프리미엄 구독자만 이용하실 수 있습니다.
              <br />
              프리미엄으로 업그레이드하고 무제한 혜택을 받아보세요!
            </p>

            <div className="upgrade-modal-features">
              <div className="feature-item">✅ 무제한 기도문 생성</div>
              <div className="feature-item">✅ PDF 다운로드</div>
              <div className="feature-item">✅ 음성 낭독</div>
              <div className="feature-item">✅ 광고 제거</div>
            </div>

            <button
              className="upgrade-modal-cta"
              onClick={() => {
                window.location.href = '/pricing';
              }}
            >
              프리미엄 시작하기 (₩4,900/월)
            </button>

            <button
              className="upgrade-modal-cancel"
              onClick={() => setShowUpgradeModal(false)}
            >
              나중에
            </button>
          </div>
        </div>
      )}
    </>
  );
}
