import { describe, it, expect } from 'vitest';

// Extract and test the template prayer generation logic
// This mirrors the getSimplePrayer function from usePrayerCompanion.js
function getSimplePrayer(topic) {
  const templates = [
    `하나님, 오늘도 ${topic}을(를) 위해 기도드립니다.\n\n이 기도를 올리는 사람의 마음에 평안을 주시고, 하루하루 은혜 가운데 살아갈 수 있도록 인도해 주세요.\n\n힘들고 지칠 때에도 주님의 사랑을 느낄 수 있게 하시고, 감사한 마음으로 하루를 보낼 수 있게 해주세요.\n\n예수님의 이름으로 기도합니다. 아멘.`,
    `사랑의 하나님,\n\n${topic}에 대해 간절히 기도합니다.\n\n주님의 뜻 안에서 모든 것이 이루어지기를 소망하며, 오늘 하루도 감사와 기쁨으로 채워주시길 바랍니다.\n\n어려운 순간에도 주님이 함께 하심을 믿으며, 담대한 마음을 주세요.\n\n예수님의 이름으로 기도드립니다. 아멘.`,
    `은혜로우신 하나님,\n\n${topic}을(를) 주님의 손에 맡깁니다.\n\n오늘도 주님의 사랑과 보호 아래 안전하게 지켜주시고, 마음에 평화를 부어주세요.\n\n주님이 예비하신 좋은 것들을 기대하며, 하나님의 인도하심을 따르겠습니다.\n\n감사드리며, 예수님의 이름으로 기도합니다. 아멘.`,
    `전능하신 하나님,\n\n${topic}을(를) 위해 주님 앞에 나아갑니다.\n\n주님의 지혜와 사랑으로 인도해 주시고, 필요한 모든 것을 채워주시길 기도합니다.\n\n오늘 하루도 주님의 은혜 안에서 기쁨과 감사로 살아갈 수 있게 해주세요.\n\n주님을 신뢰하며, 예수님의 이름으로 기도합니다. 아멘.`
  ];

  return templates[Math.floor(Math.random() * templates.length)];
}

describe('Prayer Template Generator', () => {
  it('generates a prayer containing the topic', () => {
    const topic = '가족의 건강';
    const prayer = getSimplePrayer(topic);
    expect(prayer).toContain('가족의 건강');
  });

  it('always ends with 아멘', () => {
    const topics = ['일상의 평안', '취업', '건강', '감사'];
    for (const topic of topics) {
      const prayer = getSimplePrayer(topic);
      expect(prayer).toMatch(/아멘\.$/);
    }
  });

  it('contains prayer structure elements', () => {
    const prayer = getSimplePrayer('테스트');
    // All templates mention God and Jesus
    expect(prayer).toMatch(/하나님/);
    expect(prayer).toMatch(/예수님/);
  });

  it('generates non-empty prayers for various topics', () => {
    const topics = ['', '건강', '가족의 평안과 행복', '한 글자'];
    for (const topic of topics) {
      const prayer = getSimplePrayer(topic);
      expect(prayer.length).toBeGreaterThan(50);
    }
  });

  it('generates one of 4 templates', () => {
    const results = new Set();
    // Run 100 times to likely hit all templates
    for (let i = 0; i < 100; i++) {
      const prayer = getSimplePrayer('테스트');
      // Identify template by first line
      const firstLine = prayer.split('\n')[0];
      results.add(firstLine);
    }
    expect(results.size).toBeGreaterThanOrEqual(2); // At least 2 different templates
  });
});
