import React from 'react';
import './PrayerProgress.css';

/**
 * 4-step progress indicator for prayer generation
 * Shows the current stage: 듣기 → 전달 → 위로 → 완성
 */
export function PrayerProgress({ currentStep }) {
  const steps = [
    { id: 1, label: '듣기', icon: '👂' },
    { id: 2, label: '전달', icon: '🙏' },
    { id: 3, label: '위로', icon: '💝' },
    { id: 4, label: '완성', icon: '✨' }
  ];

  return (
    <div className="prayer-progress">
      <div className="progress-steps">
        {steps.map((step, index) => (
          <React.Fragment key={step.id}>
            <div
              className={`progress-step ${currentStep >= step.id ? 'active' : ''} ${
                currentStep === step.id ? 'current' : ''
              }`}
            >
              <div className="step-icon">{step.icon}</div>
              <div className="step-label">{step.label}</div>
            </div>

            {index < steps.length - 1 && (
              <div
                className={`progress-line ${currentStep > step.id ? 'active' : ''}`}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
