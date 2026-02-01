import React, { useState, useEffect } from 'react';

function App() {
    const [topic, setTopic] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [notification, setNotification] = useState(null);

    // 랜덤 기도 알림 시뮬레이션
    useEffect(() => {
        const timer = setInterval(() => {
            if (Math.random() > 0.7) {
                const messages = [
                    "AI 그레이스가 누군가를 위해 기도 중입니다...",
                    "당신의 마음을 주님께 전달하고 있습니다.",
                    "지금 이 순간, 위로의 메시지가 생성되고 있습니다.",
                    "따뜻한 평화가 당신에게 머물기를 기도합니다."
                ];
                const randomMsg = messages[Math.floor(Math.random() * messages.length)];
                setNotification(randomMsg);
                setTimeout(() => setNotification(null), 5000);
            }
        }, 15000);

        return () => clearInterval(timer);
    }, []);

    const handleGenerate = async () => {
        if (!topic.trim()) return;

        setLoading(true);
        setResult(null);

        try {
            const response = await fetch('http://localhost:3001/api/generate-prayer', {
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
