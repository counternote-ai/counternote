import React from 'react';

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface TranscriptViewProps {
  title: string;
  segments: Segment[];
  onBack: () => void;
  onExport: () => void;
}

export function TranscriptView({ title, segments, onBack, onExport }: TranscriptViewProps) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="transcript-view">
      <div className="header">
        <button onClick={onBack}>← Back</button>
        <h2>{title}</h2>
        <button onClick={onExport}>📥 Export</button>
      </div>

      <div className="segments">
        {segments.map((seg, i) => (
          <div key={i} className="segment">
            <div className="speaker">
              {seg.speaker === 'Interviewer' ? '👤' : '🧑'} {seg.speaker}
              <span className="time">{formatTime(seg.start)}</span>
            </div>
            <div className="text">{seg.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
