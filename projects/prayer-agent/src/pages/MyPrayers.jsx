import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getUserPrayers, deletePrayer } from '../lib/supabaseClient';
import { PdfDownloadButton } from '../components/pdf/PdfDownloadButton';
import { TtsButton } from '../components/tts/TtsButton';
import './MyPrayers.css';

export function MyPrayers() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [prayers, setPrayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [emotionFilter, setEmotionFilter] = useState(null);
  const [totalCount, setTotalCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const observerTarget = useRef(null);

  const LIMIT = 20;

  const emotions = [
    { value: null, label: '전체', icon: '✨', color: '#6d5dfc' },
    { value: 'peace', label: '평안', icon: '🕊️', color: '#93c5fd' },
    { value: 'gratitude', label: '감사', icon: '🙏', color: '#fbbf24' },
    { value: 'sadness', label: '위로', icon: '💙', color: '#93c5fd' },
    { value: 'hope', label: '희망', icon: '🌟', color: '#86efac' }
  ];

  // Load prayers
  const loadPrayers = useCallback(async (reset = false) => {
    if (!user) {
      navigate('/');
      return;
    }

    if (reset) {
      setLoading(true);
      setOffset(0);
      setPrayers([]);
    } else {
      setLoadingMore(true);
    }

    try {
      const currentOffset = reset ? 0 : offset;
      const { data, error, count } = await getUserPrayers(user.id, {
        limit: LIMIT,
        offset: currentOffset,
        emotion: emotionFilter
      });

      if (error) {
        console.error('Error loading prayers:', error);
        return;
      }

      setTotalCount(count);

      if (reset) {
        setPrayers(data);
      } else {
        setPrayers(prev => [...prev, ...data]);
      }

      setHasMore(data.length === LIMIT && currentOffset + LIMIT < count);
      setOffset(currentOffset + LIMIT);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [user, offset, emotionFilter, navigate]);

  // Initial load
  useEffect(() => {
    loadPrayers(true);
  }, [emotionFilter]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadPrayers(false);
        }
      },
      { threshold: 0.1 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => {
      if (observerTarget.current) {
        observer.unobserve(observerTarget.current);
      }
    };
  }, [hasMore, loadingMore, loadPrayers]);

  // Handle delete
  const handleDelete = async (prayerId) => {
    if (!confirm('이 기도문을 삭제하시겠습니까?')) {
      return;
    }

    const { error } = await deletePrayer(prayerId, user.id);

    if (error) {
      alert('삭제 중 오류가 발생했습니다.');
      return;
    }

    // Remove from local state
    setPrayers(prev => prev.filter(p => p.id !== prayerId));
    setTotalCount(prev => prev - 1);
  };

  // Handle share
  const handleShare = async (prayer) => {
    const shareText = `${prayer.title}\n\n${prayer.content}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: prayer.title,
          text: shareText
        });
      } catch (err) {
        // User cancelled or error
        console.log('Share cancelled');
      }
    } else {
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(shareText);
      alert('기도문이 클립보드에 복사되었습니다!');
    }
  };

  // Filter by search query
  const filteredPrayers = prayers.filter(prayer =>
    searchQuery === '' ||
    prayer.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    prayer.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    prayer.topic.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Format date
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return '오늘';
    if (days === 1) return '어제';
    if (days < 7) return `${days}일 전`;

    return date.toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  // Get emotion info
  const getEmotionInfo = (emotion) => {
    return emotions.find(e => e.value === emotion) || emotions[0];
  };

  if (!user) {
    return null;
  }

  return (
    <div className="my-prayers-page">
      {/* Header */}
      <div className="prayers-header">
        <button className="back-button" onClick={() => navigate('/')}>
          ← 돌아가기
        </button>
        <h1>내 기도문</h1>
        <div className="prayer-stats">
          <span className="stat">
            <strong>{totalCount}</strong>개의 기도문
          </span>
          {profile && (
            <span className="stat">
              <strong>{profile.total_prayers_generated || 0}</strong>개 생성됨
            </span>
          )}
        </div>
      </div>

      {/* Search and filters */}
      <div className="prayers-controls">
        <div className="search-box">
          <input
            type="text"
            placeholder="기도문 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="clear-search"
              onClick={() => setSearchQuery('')}
            >
              ×
            </button>
          )}
        </div>

        <div className="emotion-filters">
          {emotions.map(emotion => (
            <button
              key={emotion.value || 'all'}
              className={`emotion-filter ${emotionFilter === emotion.value ? 'active' : ''}`}
              onClick={() => setEmotionFilter(emotion.value)}
              style={{
                '--emotion-color': emotion.color
              }}
            >
              <span className="emotion-icon">{emotion.icon}</span>
              <span className="emotion-label">{emotion.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Prayers list */}
      {loading ? (
        <div className="loading-state">
          <div className="loader"></div>
          <p>기도문을 불러오는 중...</p>
        </div>
      ) : filteredPrayers.length === 0 ? (
        <div className="empty-state">
          {searchQuery ? (
            <>
              <p className="empty-icon">🔍</p>
              <h3>검색 결과가 없습니다</h3>
              <p>다른 검색어로 시도해보세요.</p>
            </>
          ) : emotionFilter ? (
            <>
              <p className="empty-icon">{getEmotionInfo(emotionFilter).icon}</p>
              <h3>아직 {getEmotionInfo(emotionFilter).label} 기도문이 없습니다</h3>
              <p>첫 기도문을 만들어보세요!</p>
              <button className="primary-button" onClick={() => navigate('/')}>
                기도문 생성하기
              </button>
            </>
          ) : (
            <>
              <p className="empty-icon">📝</p>
              <h3>저장된 기도문이 없습니다</h3>
              <p>기도문을 생성하고 저장해보세요.</p>
              <button className="primary-button" onClick={() => navigate('/')}>
                첫 기도문 만들기
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="prayers-grid">
          {filteredPrayers.map(prayer => {
            const emotionInfo = getEmotionInfo(prayer.emotion);
            return (
              <div key={prayer.id} className="prayer-card">
                <div className="prayer-card-header">
                  <div
                    className="emotion-badge"
                    style={{ backgroundColor: emotionInfo.color }}
                  >
                    {emotionInfo.icon} {emotionInfo.label}
                  </div>
                  <span className="prayer-date">{formatDate(prayer.created_at)}</span>
                </div>

                <h3 className="prayer-title">{prayer.title}</h3>

                <div className="prayer-topic">
                  <span className="topic-label">주제:</span> {prayer.topic}
                </div>

                <p className="prayer-preview">
                  {prayer.content.substring(0, 150)}
                  {prayer.content.length > 150 && '...'}
                </p>

                <div className="prayer-actions">
                  <PdfDownloadButton prayer={prayer} compact={true} />
                  <TtsButton text={prayer.content} compact={true} />
                  <button
                    className="action-button"
                    onClick={() => handleShare(prayer)}
                    title="공유하기"
                  >
                    <span>📤</span> 공유
                  </button>
                  <button
                    className="action-button delete"
                    onClick={() => handleDelete(prayer.id)}
                    title="삭제하기"
                  >
                    <span>🗑️</span> 삭제
                  </button>
                </div>
              </div>
            );
          })}

          {/* Infinite scroll trigger */}
          {hasMore && (
            <div ref={observerTarget} className="load-more-trigger">
              {loadingMore && (
                <div className="loading-more">
                  <div className="loader-small"></div>
                  <span>더 불러오는 중...</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
