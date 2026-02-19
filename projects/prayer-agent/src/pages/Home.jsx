import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePrayerGeneration } from '../hooks/usePrayerGeneration';
import { PrayerProgress } from '../components/prayer/PrayerProgress';
import { PrayerAmbience } from '../components/prayer/PrayerAmbience';
import { LoginModal } from '../components/auth/LoginModal';
import { useAuth } from '../contexts/AuthContext';
import { checkRateLimit, logUsage, savePrayer } from '../lib/supabaseClient';
import { UpgradeBanner } from '../components/UpgradeBanner';
import { DonateButton } from '../components/donation/DonateButton';
import { PdfDownloadButton } from '../components/pdf/PdfDownloadButton';
import { TtsButton } from '../components/tts/TtsButton';
import { StreakDisplay } from '../components/streak/StreakDisplay';
import { VoiceInput } from '../components/voice/VoiceInput';
import { EmergencyPrayerButton } from '../components/emergency/EmergencyPrayerButton';
import { PrayerDashboard } from '../components/schedule/PrayerDashboard';
import { PrayerNotification } from '../components/schedule/PrayerNotification';
import { usePrayerCompanion } from '../hooks/usePrayerCompanion';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';

export function Home() {
    const navigate = useNavigate();
    const [topic, setTopic] = useState('');
    const [notification, setNotification] = useState(null);
    const [emotion, setEmotion] = useState('peace');
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [rateLimitInfo, setRateLimitInfo] = useState(null);
    const [saving, setSaving] = useState(false);
    const [currentPrayerId, setCurrentPrayerId] = useState(null);

    const { user, profile, loading: authLoading, signOut } = useAuth();
    const { currentPrayer: companionPrayer, nextPrayerTime, unviewedPrayers } = usePrayerCompanion();

    const {
        title,
        content,
        isGenerating,
        error,
        progress,
        generatePrayer,
        reset
    } = usePrayerGeneration();

    useEffect(() => {
        if (!authLoading) {
            checkUserRateLimit();
        }
    }, [user, authLoading]);

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

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);

        if (params.get('donation_success') === 'true') {
            const amount = params.get('amount');
            alert(`후원해주셔서 감사합니다! 💝\n${amount ? `₩${parseInt(amount).toLocaleString()}` : ''}\n더 나은 서비스로 보답하겠습니다.`);
            window.history.replaceState({}, document.title, window.location.pathname);
        } else if (params.get('donation_canceled') === 'true') {
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }, []);

    const checkUserRateLimit = async () => {
        const userId = user?.id || null;
        const anonymousId = !userId ? getAnonymousId() : null;

        const limitInfo = await checkRateLimit(userId, anonymousId);
        setRateLimitInfo(limitInfo);
    };

    const getAnonymousId = () => {
        const fingerprint = `${navigator.userAgent}_${screen.width}x${screen.height}`;
        return btoa(fingerprint).substring(0, 32);
    };

    const handleGenerate = async () => {
        if (!topic.trim()) return;

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

        await generatePrayer(topic);
        await logUsage(userId, anonymousId, 'prayer_generation');
        await checkUserRateLimit();
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

    const handleVoiceTranscript = (transcript, isFinal) => {
        setTopic(transcript);
    };

    return (
        <div className="container">
            {/* Breathing ambience background */}
            <PrayerAmbience isActive={isGenerating} emotion={emotion} />

            {/* Live notification */}
            {notification && (
                <div className="live-notification">
                    <span className="pulse-dot" />
                    {notification}
                </div>
            )}

            {/* User Section */}
            <div className="user-section">
                {authLoading ? (
                    <div className="user-loading">로딩 중...</div>
                ) : user ? (
                    <div className="user-profile">
                        <span className="user-name">
                            {profile?.display_name || user.email}
                        </span>
                        <StreakDisplay profile={profile} />
                        <button
                            className="my-prayers-link"
                            onClick={() => navigate('/my-prayers')}
                        >
                            📖 내 기도문
                        </button>
                        <DonateButton />
                        <button className="logout-btn" onClick={handleLogout}>
                            로그아웃
                        </button>
                    </div>
                ) : (
                    <button className="login-btn" onClick={() => setShowLoginModal(true)}>
                        시작하기
                    </button>
                )}
            </div>

            {/* Header */}
            <h1>grace-ai</h1>
            <p className="subtitle">당신의 마음을 담은 AI 기도문</p>

            {/* Progress indicator */}
            {isGenerating && progress > 0 && (
                <PrayerProgress currentStep={progress} />
            )}

            {/* Rate limit warning for anonymous users */}
            {!user && rateLimitInfo && (
                <div className="rate-limit-info">
                    <p>
                        ✨ 오늘 {rateLimitInfo.remaining || 0}회 남았습니다.{' '}
                        <button
                            className="inline-link-btn"
                            onClick={() => setShowLoginModal(true)}
                        >
                            회원가입
                        </button>
                        하시면 더 많이 이용하실 수 있어요!
                    </p>
                </div>
            )}

            {/* Upgrade banner */}
            <UpgradeBanner profile={profile} rateLimitInfo={rateLimitInfo} />

            {/* Input section */}
            <div className="input-section">
                <div className="input-with-voice">
                    <textarea
                        placeholder="오늘 감사한 일, 힘든 일, 기도하고 싶은 내용을 자유롭게 적어주세요..."
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        disabled={isGenerating}
                    />
                    <VoiceInput onTranscript={handleVoiceTranscript} />
                </div>
                <div className="action-buttons">
                    <Button
                        onClick={handleGenerate}
                        disabled={isGenerating || !topic.trim()}
                        isLoading={isGenerating}
                        className="generate-button"
                        size="lg"
                    >
                        {isGenerating ? '🙏 기도하는 중...' : '✨ 기도 맡기기'}
                    </Button>
                    <EmergencyPrayerButton />
                </div>
            </div>

            {/* Error message */}
            {error && (
                <div className="error-message">
                    {error}
                </div>
            )}

            {/* Prayer result */}
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
                                <Button
                                    onClick={() => handleSavePrayer(false)}
                                    disabled={saving}
                                    isLoading={saving}
                                    size="sm"
                                >
                                    {saving ? '저장 중...' : '💾 저장하기'}
                                </Button>
                            )}
                            {currentPrayerId && (
                                <span className="saved-indicator">✓ 저장됨</span>
                            )}
                            <PdfDownloadButton
                                prayer={{
                                    title,
                                    content,
                                    topic,
                                    emotion,
                                    created_at: new Date().toISOString()
                                }}
                            />
                            <TtsButton text={content} />
                            <Button variant="outline" size="sm" onClick={handleReset}>
                                새로운 기도문
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* 기도 동반자 대시보드 - 로그인 사용자만 */}
            {user && (
                <PrayerDashboard />
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

            {/* 실시간 기도 알림 (화면 하단 고정) */}
            <PrayerNotification
                prayer={companionPrayer}
                onDismiss={() => {}}
            />
        </div>
    );
}
