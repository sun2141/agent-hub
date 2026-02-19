import { PDFDownloadLink } from '@react-pdf/renderer';
import { PrayerPdfDocument } from './PrayerPdfDocument';
import './PdfDownloadButton.css';

export function PdfDownloadButton({ prayer, compact = false }) {
  if (!prayer || !prayer.title || !prayer.content) {
    return null;
  }

  const fileName = `${prayer.title.substring(0, 20)}_${new Date(prayer.created_at).toLocaleDateString('ko-KR').replace(/\./g, '')}.pdf`;

  return (
    <PDFDownloadLink
      document={<PrayerPdfDocument prayer={prayer} />}
      fileName={fileName}
      className={compact ? 'pdf-download-btn-compact' : 'pdf-download-btn'}
    >
      {({ loading }) =>
        loading ? (
          compact ? '⏳' : '📄 PDF 준비 중...'
        ) : (
          compact ? '📄' : '📄 PDF 다운로드'
        )
      }
    </PDFDownloadLink>
  );
}
