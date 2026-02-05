import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrayerNotification } from '../PrayerNotification';

describe('PrayerNotification', () => {
  const mockPrayer = {
    prayer_title: '가족을 위한 기도',
    prayer_content: '하나님, 오늘도 가족의 건강과 평안을 위해 기도드립니다. 이 기도를 올리는 사람의 마음에 평안을 주시고, 하루하루 은혜 가운데 살아갈 수 있도록 인도해 주세요.',
  };

  it('renders nothing when prayer is null', () => {
    const { container } = render(<PrayerNotification prayer={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders notification with prayer title', () => {
    render(<PrayerNotification prayer={mockPrayer} />);
    expect(screen.getByText('AI가 지금 당신을 위해 기도하고 있습니다')).toBeInTheDocument();
    expect(screen.getByText('가족을 위한 기도')).toBeInTheDocument();
  });

  it('shows default title when prayer_title is missing', () => {
    render(<PrayerNotification prayer={{ prayer_content: 'test' }} />);
    expect(screen.getByText('오늘의 기도')).toBeInTheDocument();
  });

  it('expands on click to show prayer content', () => {
    render(<PrayerNotification prayer={mockPrayer} />);

    // Click the main notification area
    fireEvent.click(screen.getByText('AI가 지금 당신을 위해 기도하고 있습니다'));

    // Should show prayer content (truncated to 200 chars)
    expect(screen.getByText(/하나님, 오늘도 가족의 건강과 평안을/)).toBeInTheDocument();
    expect(screen.getByText('전체 기도문 보기 →')).toBeInTheDocument();
  });

  it('calls onDismiss when close button clicked', () => {
    const onDismiss = vi.fn();
    render(<PrayerNotification prayer={mockPrayer} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('×'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onView with prayer when view button clicked', () => {
    const onView = vi.fn();
    render(<PrayerNotification prayer={mockPrayer} onView={onView} />);

    // Expand first
    fireEvent.click(screen.getByText('AI가 지금 당신을 위해 기도하고 있습니다'));

    // Click view full button
    fireEvent.click(screen.getByText('전체 기도문 보기 →'));
    expect(onView).toHaveBeenCalledWith(mockPrayer);
  });

  it('truncates long prayer content at 200 characters', () => {
    const longContent = 'A'.repeat(300);
    const prayer = { ...mockPrayer, prayer_content: longContent };
    render(<PrayerNotification prayer={prayer} />);

    fireEvent.click(screen.getByText('AI가 지금 당신을 위해 기도하고 있습니다'));

    // Should show truncated text with ellipsis
    expect(screen.getByText(/\.\.\.$/)).toBeInTheDocument();
  });
});
