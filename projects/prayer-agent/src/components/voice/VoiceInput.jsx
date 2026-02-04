import { useState, useEffect, useRef } from 'react';
import './VoiceInput.css';

export function VoiceInput({ onTranscript, disabled = false }) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);

  useEffect(() => {
    // Check if Web Speech API is supported
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      setIsSupported(true);

      // Initialize speech recognition
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'ko-KR'; // Korean

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };

      recognition.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }

        // Send transcript to parent (even interim results)
        if (onTranscript) {
          onTranscript(transcript, event.results[event.results.length - 1].isFinal);
        }
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);

        switch (event.error) {
          case 'not-allowed':
          case 'permission-denied':
            setError('마이크 권한이 필요합니다. 브라우저 설정에서 마이크를 허용해주세요.');
            break;
          case 'no-speech':
            setError('음성이 감지되지 않았습니다. 다시 시도해주세요.');
            break;
          case 'network':
            setError('네트워크 오류가 발생했습니다.');
            break;
          default:
            setError('음성 인식 중 오류가 발생했습니다.');
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } else {
      setIsSupported(false);
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [onTranscript]);

  const startListening = () => {
    if (recognitionRef.current && !isListening) {
      try {
        recognitionRef.current.start();
      } catch (err) {
        console.error('Failed to start recognition:', err);
        setError('음성 인식을 시작할 수 없습니다.');
      }
    }
  };

  const stopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
    }
  };

  if (!isSupported) {
    return (
      <div className="voice-input-unsupported" title="이 브라우저는 음성 입력을 지원하지 않습니다">
        <button className="voice-button" disabled>
          🎤
        </button>
      </div>
    );
  }

  return (
    <div className="voice-input-container">
      <button
        className={`voice-button ${isListening ? 'listening' : ''}`}
        onClick={isListening ? stopListening : startListening}
        disabled={disabled}
        title={isListening ? '음성 인식 중... (클릭하여 중지)' : '마이크 버튼을 눌러 음성으로 입력하세요'}
      >
        {isListening ? (
          <span className="mic-pulse">
            <span className="pulse-ring"></span>
            <span className="mic-icon">🎤</span>
          </span>
        ) : (
          <span className="mic-icon">🎤</span>
        )}
      </button>

      {isListening && (
        <div className="voice-status">
          <div className="voice-animation">
            <span className="wave"></span>
            <span className="wave"></span>
            <span className="wave"></span>
          </div>
          <span className="voice-text">듣고 있어요...</span>
        </div>
      )}

      {error && (
        <div className="voice-error">
          <span className="error-icon">⚠️</span>
          <span className="error-text">{error}</span>
        </div>
      )}
    </div>
  );
}
