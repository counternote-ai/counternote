import React from 'react';

interface Recording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
}

interface ControlPanelProps {
  recordings: Recording[];
  onStartRecording: () => void;
  onStopRecording: () => void;
  onTranscribe: (id: string) => void;
  onSelectRecording: (id: string) => void;
  onOpenSettings: () => void;
  isRecording: boolean;
  isTranscribing?: boolean;
}

export function ControlPanel({
  recordings,
  onStartRecording,
  onStopRecording,
  onTranscribe,
  onSelectRecording,
  onOpenSettings,
  isRecording,
  isTranscribing,
}: ControlPanelProps) {
  return (
    <div className="control-panel">
      <div className="actions">
        {isRecording ? (
          <button onClick={onStopRecording} className="stop-btn">
            ⏹ Stop Recording
          </button>
        ) : (
          <button onClick={onStartRecording} className="start-btn">
            ● Start Recording
          </button>
        )}
        <button onClick={onOpenSettings} className="settings-btn">
          ⚙️ Settings
        </button>
      </div>

      <div className="recordings-list">
        <h3>Past Interviews</h3>
        {recordings.length === 0 ? (
          <p>No recordings yet</p>
        ) : (
          recordings.map((rec) => (
            <div key={rec.id} className="recording-item">
              <div onClick={() => onSelectRecording(rec.id)}>
                <strong>{rec.title}</strong>
                <span>{Math.floor(rec.duration / 60)}:{(rec.duration % 60).toString().padStart(2, '0')}</span>
              </div>
              {!rec.transcribed && (
                <button onClick={() => onTranscribe(rec.id)} disabled={isTranscribing}>
                  {isTranscribing ? 'Transcribing...' : 'Transcribe'}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
