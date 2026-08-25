import { exportToPlainText } from '../export';
import { Transcript } from '../../types/transcript';

describe('Export', () => {
  const mockTranscript: Transcript = {
    id: '2026-07-08T14-30-00',
    title: 'Meeting — Jul 8, 2026',
    duration: 1847,
    audioFile: 'audio.wav',
    createdAt: '2026-07-08T14:30:00Z',
    transcribedAt: '2026-07-08T15:05:12Z',
    segments: [
      { start: 0.0, end: 4.2, speaker: 'Interviewer', text: 'Tell me about yourself.' },
      {
        start: 4.5,
        end: 28.1,
        speaker: 'You',
        text: "Sure, I'm a software engineer with 5 years of experience.",
      },
      {
        start: 28.3,
        end: 32.0,
        speaker: 'Interviewer',
        text: "Great. What's your experience with React?",
      },
    ],
  };

  it('should export transcript to plain text with correct format', () => {
    const result = exportToPlainText(mockTranscript);

    // Should contain title
    expect(result).toContain('Meeting — Jul 8, 2026');

    // Should contain duration
    expect(result).toContain('Duration: 30:47');

    // Should contain timestamps
    expect(result).toContain('[0:00] Meeting audio:');
    expect(result).toContain('[0:04] You:');
    expect(result).toContain('[0:28] Meeting audio:');

    // Should contain segment text
    expect(result).toContain('Tell me about yourself.');
    expect(result).toContain("Sure, I'm a software engineer with 5 years of experience.");
    expect(result).toContain("Great. What's your experience with React?");
  });

  it('should handle empty segments array', () => {
    const emptyTranscript: Transcript = {
      ...mockTranscript,
      segments: [],
    };

    const result = exportToPlainText(emptyTranscript);

    expect(result).toContain('Meeting — Jul 8, 2026');
    expect(result).toContain('Duration: 30:47');
  });

  it('should format timestamps correctly', () => {
    const transcript: Transcript = {
      ...mockTranscript,
      segments: [
        { start: 0, end: 1, speaker: 'You', text: 'Start' },
        { start: 65, end: 66, speaker: 'You', text: 'After 1 minute' },
        { start: 3661, end: 3662, speaker: 'You', text: 'After 1 hour and 1 minute' },
      ],
    };

    const result = exportToPlainText(transcript);

    expect(result).toContain('[0:00] You:');
    expect(result).toContain('[1:05] You:');
    expect(result).toContain('[61:01] You:');
  });

  it('should normalize the legacy Interviewer label without changing other speaker labels', () => {
    const originalSegments = structuredClone(mockTranscript.segments);
    const result = exportToPlainText(mockTranscript);

    expect(result).not.toContain('Interviewer:');
    expect(result).toContain('Meeting audio:');
    expect(result).toContain('You:');
    expect(mockTranscript.segments).toEqual(originalSegments);
  });
});
