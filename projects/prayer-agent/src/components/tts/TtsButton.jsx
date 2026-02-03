import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './TtsButton.css';

export function TtsButton({ text, compact = false }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [error, setError] = useState(null);
  const audioRef = useRef(null);
  const { profile } = useAuth();

  const isPremium = profile?.subscription_tier === 'premium';

  useEffect(() => {
    // Cleanup audio on unmount
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handlePlay = async () => {
    if (!isPremium) {
      setShowUpgradeModal(true);
      return;
    }

    if (!text || text.trim().length === 0) {
      setError('재생할 텍스트가 없습니다.');
      return;
    }

    // If already playing, pause
    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    // If audio exists, resume
    if (audioRef.current && !audioRef.current.ended) {
      audioRef.current.play();
      setIsPlaying(true);
      return;
    }

    // Generate new audio
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/tts/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'TTS 생성에 실패했습니다.');
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);

      audioRef.current = new Audio(audioUrl);

      audioRef.current.onended = () => {
        setIsPlaying(false);
      };

      audioRef.current.onerror = () => {
        setError('오디오 재생 중 오류가 발생했습니다.');
        setIsPlaying(false);
      };

      await audioRef.current.play();
      setIsPlaying(true);
    } catch (err) {
      console.error('TTS error:', err);
      setError(err.message || 'TTS 생성 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  const getButtonContent = () => {
    if (compact) {
      if (isLoading) return '⏳';
      if (isPlaying) return '⏸️';
      if (!isPremium) return '🔒';
      return '🔊';
    }

    if (isLoading) return '🔊 음성 생성 중...';
    if (isPlaying) return '⏸️ 일시정지';
    if (!isPremium) return '🔒 음성 낭독 (프리미엄)';
    return '🔊 음성 낭독';
  };

  return (
    <>
      <button
        className={compact ? 'tts-button-compact' : 'tts-button'}
        onClick={handlePlay}
        disabled={isLoading}
        title={compact ? '음성 낭독' : undefined}
      >
        {getButtonContent()}
      </button>

      {error && !compact && (
        <div className="tts-error">
          ⚠️ {error}
        </div>
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
              음성 낭독은 프리미엄 구독자만 이용하실 수 있습니다.
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
