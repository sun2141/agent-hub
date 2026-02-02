import React, { useState, useEffect } from 'react';
import { usePrayerGeneration } from './hooks/usePrayerGeneration';
import { PrayerProgress } from './components/prayer/PrayerProgress';
import { PrayerAmbience } from './components/prayer/PrayerAmbience';

function App() {
    const [topic, setTopic] = useState('');
    const [notification, setNotification] = useState(null);
    const [emotion, setEmotion] = useState('peace');

    const {
        title,
        content,
        isGenerating,
        error,
        progress,
        generatePrayer,
        reset
    } = usePrayerGeneration();

    // 배경 활동 알림 (백엔드 연동)
    useEffect(() => {
        const fetchActivity = async () => {
            try {
                const response = await fetch('/api/background-activities');
                if (response.ok) {
                    const data = await response.json();
                    setNotification(data.message);
                    setTimeout(() => setNotification(null), 6000);
                }
            } catch (error) {
                console.error('Error fetching activity:', error);
            }
        };

        const timer = setInterval(() => {
            if (Math.random() > 0.6) {
                fetchActivity();
            }
        }, 12000);

        return () => clearInterval(timer);
    }, []);

    // Detect emotion from topic for ambience color
    useEffect(() => {
        if (!topic) return;

        const lowerTopic = topic.toLowerCase();
        if (lowerTopic.includes('감사') || lowerTopic.includes('기쁨')) {
            setEmotion('gratitude');
        } else if (lowerTopic.includes('슬픔') || lowerTopic.includes('아픔') || lowerTopic.includes('힘들')) {
            setEmotion('sadness');
        } else if (lowerTopic.includes('소망') || lowerTopic.includes('희망')) {
            setEmotion('hope');
        } else {
            setEmotion('peace');
        }
    }, [topic]);

    const handleGenerate = async () => {
        if (!topic.trim()) return;
        await generatePrayer(topic);
    };

    const handleReset = () => {
        setTopic('');
        reset();
    };

    return (
        <div className="container">
            {/* Breathing ambience background */}
            <PrayerAmbience isActive={isGenerating} emotion={emotion} />

            {notification && (
                <div className="live-notification">
                    <span className="pulse-dot"></span>
                    {notification}
                </div>
            )}

            <h1>grace-ai</h1>
            <p className="subtitle">따뜻함을 전하는 AI 기도문</p>

            {/* Show progress indicator when generating */}
            {isGenerating && progress > 0 && (
                <PrayerProgress currentStep={progress} />
            )}

            <div className="input-section">
                <textarea
                    placeholder="오늘의 고민이나 감사하고 싶은 내용을 들려주세요..."
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    disabled={isGenerating}
                />
                <button
                    onClick={handleGenerate}
                    disabled={isGenerating || !topic.trim()}
                >
                    {isGenerating ? '기도문 작성 중...' : '기도문 생성하기'}
                </button>
            </div>

            {/* Error message */}
            {error && (
                <div className="error-message">
                    {error}
                </div>
            )}

            {/* Prayer result with streaming effect */}
            {(title || content) && (
                <div className="prayer-result">
                    {title && <h2>{title}</h2>}
                    {content && (
                        <div className="prayer-content">
                            {content}
                        </div>
                    )}
                    {!isGenerating && (title || content) && (
                        <button className="reset-button" onClick={handleReset}>
                            새로운 기도문 작성하기
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export default App;
