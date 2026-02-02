import React, { useState, useEffect } from 'react';
import { usePrayerGeneration } from './hooks/usePrayerGeneration';
import { PrayerProgress } from './components/prayer/PrayerProgress';
import { PrayerAmbience } from './components/prayer/PrayerAmbience';
import { LoginModal } from './components/auth/LoginModal';
import { useAuth } from './contexts/AuthContext';
import { checkRateLimit, logUsage, savePrayer } from './lib/supabaseClient';

function App() {
    const [topic, setTopic] = useState('');
    const [notification, setNotification] = useState(null);
    const [emotion, setEmotion] = useState('peace');
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [rateLimitInfo, setRateLimitInfo] = useState(null);
    const [saving, setSaving] = useState(false);
    const [currentPrayerId, setCurrentPrayerId] = useState(null);

    const { user, profile, loading: authLoading, signOut } = useAuth();

    const {
        title,
        content,
        isGenerating,
        error,
        progress,
        generatePrayer,
        reset
    } = usePrayerGeneration();

    // Check rate limit on mount and when user changes
    useEffect(() => {
        if (!authLoading) {
            checkUserRateLimit();
        }
    }, [user, authLoading]);

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

    const checkUserRateLimit = async () => {
        const userId = user?.id || null;
        const anonymousId = !userId ? getAnonymousId() : null;

        const limitInfo = await checkRateLimit(userId, anonymousId);
        setRateLimitInfo(limitInfo);
    };

    const getAnonymousId = () => {
        // Use a simple fingerprint based on user agent and screen size
        const fingerprint = `${navigator.userAgent}_${screen.width}x${screen.height}`;
        return btoa(fingerprint).substring(0, 32);
    };

    const handleGenerate = async () => {
        if (!topic.trim()) return;

        // Check rate limit
        const userId = user?.id || null;
        const anonymousId = !userId ? getAnonymousId() : null;

        const limitCheck = await checkRateLimit(userId, anonymousId);

        if (!limitCheck.allowed) {
            alert(limitCheck.message);
            if (!user) {
                setShowLoginModal(true);
            }
            return;
        }

        // Generate prayer
        await generatePrayer(topic);

        // Log usage
        await logUsage(userId, anonymousId, 'prayer_generation');

        // Update rate limit info
        await checkUserRateLimit();

        // Reset prayer ID for new prayer
        setCurrentPrayerId(null);
    };

    const handleSavePrayer = async (isPublic = false) => {
        if (!user) {
            alert('기도문을 저장하려면 로그인이 필요합니다.');
            setShowLoginModal(true);
            return;
        }

        if (!title || !content) {
            alert('저장할 기도문이 없습니다.');
            return;
        }

        setSaving(true);

        const result = await savePrayer({
            userId: user.id,
            title,
            content,
            topic,
            emotion,
            isPublic
        });

        setSaving(false);

        if (result.error) {
            alert(`저장 실패: ${result.error}`);
        } else {
            setCurrentPrayerId(result.data.id);
            alert('기도문이 저장되었습니다!');
        }
    };

    const handleReset = () => {
        setTopic('');
        reset();
        setCurrentPrayerId(null);
    };

    const handleLogout = async () => {
        await signOut();
        setRateLimitInfo(null);
        handleReset();
    };

    return (
        <div className="container">
            {/* Breathing ambience background */}
            <PrayerAmbience isActive={isGenerating} emotion={emotion} />

            {/* User Profile / Login Button */}
            <div className="user-section">
                {authLoading ? (
                    <div className="user-loading">로딩 중...</div>
                ) : user ? (
                    <div className="user-profile">
                        <span className="user-name">
                            {profile?.display_name || user.email}
                        </span>
                        <span className="user-tier">
                            {profile?.subscription_tier === 'premium' ? '⭐ 프리미엄' : '무료'}
                        </span>
                        {rateLimitInfo && rateLimitInfo.tier !== 'premium' && (
                            <span className="rate-limit-badge">
                                오늘 {rateLimitInfo.remaining || 0}회 남음
                            </span>
                        )}
                        <button className="logout-btn" onClick={handleLogout}>
                            로그아웃
                        </button>
                    </div>
                ) : (
                    <button className="login-btn" onClick={() => setShowLoginModal(true)}>
                        로그인 / 회원가입
                    </button>
                )}
            </div>

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

            {/* Rate limit warning for anonymous users */}
            {!user && rateLimitInfo && (
                <div className="rate-limit-info">
                    <p>
                        🎁 오늘 {rateLimitInfo.remaining || 0}회 남았습니다.
                        <button
                            className="inline-link-btn"
                            onClick={() => setShowLoginModal(true)}
                        >
                            회원가입
                        </button>
                        하시면 하루 10회까지 이용 가능합니다!
                    </p>
                </div>
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
                        <div className="prayer-actions">
                            {user && !currentPrayerId && (
                                <button
                                    className="save-button"
                                    onClick={() => handleSavePrayer(false)}
                                    disabled={saving}
                                >
                                    {saving ? '저장 중...' : '💾 저장하기'}
                                </button>
                            )}
                            {currentPrayerId && (
                                <span className="saved-indicator">✓ 저장됨</span>
                            )}
                            <button className="reset-button" onClick={handleReset}>
                                새로운 기도문 작성하기
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Login Modal */}
            <LoginModal
                isOpen={showLoginModal}
                onClose={() => setShowLoginModal(false)}
                onSuccess={() => {
                    setShowLoginModal(false);
                    checkUserRateLimit();
                }}
            />
        </div>
    );
}

export default App;
