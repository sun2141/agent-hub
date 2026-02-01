import React, { useState, useEffect } from 'react';

function App() {
    const [topic, setTopic] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [notification, setNotification] = useState(null);

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

    const handleGenerate = async () => {
        if (!topic.trim()) return;

        setLoading(true);
        setResult(null);

        try {
            const response = await fetch('/api/generate-prayer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ topic }),
            });

            if (!response.ok) {
                throw new Error('API request failed');
            }

            const data = await response.json();
            setResult(data);
        } catch (error) {
            console.error('Error generating prayer:', error);
            alert('기도문을 생성하는 중 오류가 발생했습니다. 서버가 실행 중인지 확인해주세요.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container">
            {notification && (
                <div className="live-notification">
                    <span className="pulse-dot"></span>
                    {notification}
                </div>
            )}

            <h1>grace-ai</h1>
            <p className="subtitle">따뜻함을 전하는 AI 기도문</p>

            <div className="input-section">
                <textarea
                    placeholder="오늘의 고민이나 감사하고 싶은 내용을 들려주세요..."
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    disabled={loading}
                />
                <button
                    onClick={handleGenerate}
                    disabled={loading || !topic.trim()}
                >
                    {loading ? '기도문 작성 중...' : '기도문 생성하기'}
                </button>
            </div>

            {result && (
                <div className="prayer-result">
                    <h2>{result.title}</h2>
                    <div className="prayer-content">
                        {result.content}
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
