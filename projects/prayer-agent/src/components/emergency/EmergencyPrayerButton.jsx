import { useState } from 'react';
import './EmergencyPrayerButton.css';

const EMERGENCY_PRAYERS = [
  {
    situation: 'anxiety',
    title: '평안의 기도',
    prayer: '하나님, 지금 이 순간 제 마음이 너무 불안합니다.\n\n깊은 숨을 쉬며, 당신의 평안이 저를 감싸주심을 느낍니다.\n\n모든 걱정과 두려움을 당신께 내려놓습니다.\n\n저는 혼자가 아니며, 당신이 함께하심을 믿습니다.\n\n이 순간, 평안을 주소서.\n\n아멘.'
  },
  {
    situation: 'crisis',
    title: '위로의 기도',
    prayer: '하나님, 지금 저는 힘듭니다.\n\n이 순간 당신의 위로가 필요합니다.\n\n제 눈물을 보시고, 제 아픔을 아시는 하나님.\n\n저를 안아주소서.\n\n이 어려움도 지나갈 것을 믿습니다.\n\n당신의 사랑 안에서 쉬게 하소서.\n\n아멘.'
  },
  {
    situation: 'strength',
    title: '힘의 기도',
    prayer: '하나님, 더 이상 견딜 힘이 없습니다.\n\n당신의 힘을 주소서.\n\n저의 약함 가운데 당신의 능력이 온전하게 나타나기를 기도합니다.\n\n한 걸음씩, 당신과 함께 나아가게 하소서.\n\n저는 할 수 있습니다. 당신이 함께하시니까요.\n\n아멘.'
  }
];

export function EmergencyPrayerButton({ onPrayerGenerated }) {
  const [showModal, setShowModal] = useState(false);
  const [selectedPrayer, setSelectedPrayer] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleEmergencyClick = () => {
    setShowModal(true);
  };

  const handleSelectPrayer = async (prayer) => {
    setSelectedPrayer(prayer);
    setIsGenerating(true);

    // Simulate brief generation time for better UX
    await new Promise(resolve => setTimeout(resolve, 500));

    setIsGenerating(false);

    // Pass prayer to parent
    if (onPrayerGenerated) {
      onPrayerGenerated({
        title: prayer.title,
        content: prayer.prayer,
        isEmergency: true
      });
    }

    // Close modal after a moment to let user see the prayer
    setTimeout(() => {
      setShowModal(false);
      setSelectedPrayer(null);
    }, 1000);
  };

  return (
    <>
      <button className="emergency-button" onClick={handleEmergencyClick}>
        <span className="emergency-icon">🆘</span>
        <span className="emergency-text">지금 기도가 필요해요</span>
      </button>

      {showModal && (
        <div className="emergency-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="emergency-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="emergency-modal-close"
              onClick={() => setShowModal(false)}
            >
              ✕
            </button>

            <div className="emergency-modal-header">
              <h2>지금 기도가 필요해요</h2>
              <p>지금 이 순간, 필요한 기도를 선택하세요</p>
            </div>

            {!selectedPrayer ? (
              <div className="emergency-options">
                <button
                  className="emergency-option"
                  onClick={() => handleSelectPrayer(EMERGENCY_PRAYERS[0])}
                  disabled={isGenerating}
                >
                  <div className="option-icon">😰</div>
                  <div className="option-title">불안할 때</div>
                  <div className="option-desc">평안의 기도가 필요해요</div>
                </button>

                <button
                  className="emergency-option"
                  onClick={() => handleSelectPrayer(EMERGENCY_PRAYERS[1])}
                  disabled={isGenerating}
                >
                  <div className="option-icon">😢</div>
                  <div className="option-title">힘들 때</div>
                  <div className="option-desc">위로가 필요해요</div>
                </button>

                <button
                  className="emergency-option"
                  onClick={() => handleSelectPrayer(EMERGENCY_PRAYERS[2])}
                  disabled={isGenerating}
                >
                  <div className="option-icon">💪</div>
                  <div className="option-title">지칠 때</div>
                  <div className="option-desc">힘이 필요해요</div>
                </button>
              </div>
            ) : (
              <div className="emergency-prayer-preview">
                {isGenerating ? (
                  <div className="generating-prayer">
                    <div className="prayer-loader"></div>
                    <p>기도를 준비하고 있습니다...</p>
                  </div>
                ) : (
                  <div className="prayer-ready">
                    <div className="ready-icon">✨</div>
                    <p>기도가 준비되었습니다</p>
                  </div>
                )}
              </div>
            )}

            <div className="emergency-footer">
              <p>💝 당신은 혼자가 아닙니다</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
