import { useState, useRef, useEffect } from 'react';
import './TtsButton.css';

export function TtsButton({ text, compact = false }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const audioRef = useRef(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handlePlay = async () => {
    if (!text || text.trim().length === 0) {
      setError('재생할 텍스트가 없습니다.');
      return;
    }

    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    if (audioRef.current && !audioRef.current.ended) {
      audioRef.current.play();
      setIsPlaying(true);
      return;
    }

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
      return '🔊';
    }

    if (isLoading) return '🔊 음성 생성 중...';
    if (isPlaying) return '⏸️ 일시정지';
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
    </>
  );
}
