import { useState, useCallback, useRef } from 'react';

/**
 * Custom hook for streaming text from Server-Sent Events (SSE)
 * Handles real-time streaming of prayer text with typing effect
 */
export function useStreamingText() {
  const [streamedText, setStreamedText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);

  const startStreaming = useCallback(async (topic) => {
    setIsStreaming(true);
    setStreamedText('');
    setError(null);

    try {
      // Close any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // Create EventSource for SSE
      const eventSource = new EventSource(
        `/api/generate-prayer-stream?topic=${encodeURIComponent(topic)}`
      );
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.done) {
          // Streaming complete
          eventSource.close();
          setIsStreaming(false);
        } else if (data.chunk) {
          // Append new chunk with typing delay
          setStreamedText(prev => prev + data.chunk);
        } else if (data.error) {
          // Handle error from server
          setError(data.error);
          eventSource.close();
          setIsStreaming(false);
        }
      };

      eventSource.onerror = (err) => {
        console.error('SSE error:', err);
        setError('스트리밍 연결 오류가 발생했습니다.');
        eventSource.close();
        setIsStreaming(false);
      };

    } catch (err) {
      console.error('Streaming error:', err);
      setError('기도문 스트리밍 중 오류가 발생했습니다.');
      setIsStreaming(false);
    }
  }, []);

  const stopStreaming = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  return {
    streamedText,
    isStreaming,
    error,
    startStreaming,
    stopStreaming
  };
}
