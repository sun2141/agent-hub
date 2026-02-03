import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer';

// Register Korean font (using system fonts as fallback)
// Note: For production, upload Noto Sans KR to public folder
Font.register({
  family: 'NotoSansKR',
  fonts: [
    {
      src: 'https://fonts.gstatic.com/s/notosanskr/v27/PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.ttf',
      fontWeight: 400,
    },
    {
      src: 'https://fonts.gstatic.com/s/notosanskr/v27/PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.ttf',
      fontWeight: 700,
    },
  ],
});

const styles = StyleSheet.create({
  page: {
    flexDirection: 'column',
    backgroundColor: '#ffffff',
    padding: 60,
    fontFamily: 'NotoSansKR',
  },
  header: {
    marginBottom: 30,
    paddingBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: '#667eea',
  },
  logo: {
    fontSize: 28,
    fontWeight: 700,
    color: '#667eea',
    marginBottom: 5,
  },
  tagline: {
    fontSize: 12,
    color: '#666',
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    marginTop: 30,
    marginBottom: 10,
    color: '#333',
  },
  metadata: {
    fontSize: 10,
    color: '#999',
    marginBottom: 25,
    flexDirection: 'row',
    gap: 15,
  },
  metaItem: {
    marginRight: 15,
  },
  content: {
    fontSize: 14,
    lineHeight: 2,
    color: '#333',
    textAlign: 'left',
  },
  footer: {
    position: 'absolute',
    bottom: 40,
    left: 60,
    right: 60,
    textAlign: 'center',
    fontSize: 10,
    color: '#999',
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  emotionBadge: {
    fontSize: 10,
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
});

const emotionColors = {
  peace: '#667eea',
  gratitude: '#f97316',
  sadness: '#3b82f6',
  hope: '#10b981',
  joy: '#eab308',
};

const emotionLabels = {
  peace: '평안',
  gratitude: '감사',
  sadness: '위로',
  hope: '희망',
  joy: '기쁨',
};

export function PrayerPdfDocument({ prayer }) {
  const { title, content, topic, emotion, created_at } = prayer;
  const date = new Date(created_at).toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>grace-ai</Text>
          <Text style={styles.tagline}>따뜻함을 전하는 AI 기도문</Text>
        </View>

        {/* Title */}
        <Text style={styles.title}>{title}</Text>

        {/* Metadata */}
        <View style={styles.metadata}>
          <Text style={styles.metaItem}>📅 {date}</Text>
          {topic && <Text style={styles.metaItem}>🏷️ {topic}</Text>}
          {emotion && (
            <Text
              style={[
                styles.emotionBadge,
                { color: emotionColors[emotion] || '#666' },
              ]}
            >
              {emotionLabels[emotion] || emotion}
            </Text>
          )}
        </View>

        {/* Content */}
        <Text style={styles.content}>{content}</Text>

        {/* Footer */}
        <View style={styles.footer}>
          <Text>Grace-AI로 생성된 기도문입니다 • prayer-agent.vercel.app</Text>
        </View>
      </Page>
    </Document>
  );
}
