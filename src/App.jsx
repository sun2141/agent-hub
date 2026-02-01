import React, { useState } from 'react';

function App() {
    const [topic, setTopic] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);

    const handleGenerate = async () => {
        if (!topic.trim()) return;

        setLoading(true);
        setResult(null);

        try {
            // simulate artificial delay for "AI thinking" feel
            await new Promise(resolve => setTimeout(resolve, 1500));

            // In a real Layer 2/3 setup, we would call an API or a local script.
            // For now, let's use a mock implementation that mimics the Python script behavior.
            const mockResult = {
                title: `'${topic}'을 위한 기도`,
                content: `사랑과 은혜가 풍성하신 하나님,\n\n오늘 '${topic}'이라는 마음의 짐을 가지고 주님 앞에 나온 당신의 자녀를 굽어살펴 주시옵소서. 우리의 연약함을 아시는 주님께서 이 상황 속에서 새 힘을 주시고, 보이지 않는 손길로 인도하여 주시기를 간절히 기도합니다.\n\n평안을 너희에게 끼치노니 곧 나의 평안을 너희에게 주노라 말씀하신 주님, 불안과 걱정 대신 주님이 주시는 참된 평화를 누리게 하옵소서.\n\n예수님의 이름으로 기도드립니다. 아멘.`
            };

            setResult(mockResult);
        } catch (error) {
            console.error('Error generating prayer:', error);
            alert('기도문을 생성하는 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container">
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
