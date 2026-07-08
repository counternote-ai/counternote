import React, { useState } from 'react';

interface SettingsProps {
  apiKey: string;
  model: string;
  autoTranscribe: boolean;
  onSave: (settings: { apiKey: string; model: string; autoTranscribe: boolean }) => void;
  onBack: () => void;
}

export function Settings({ apiKey, model, autoTranscribe, onSave, onBack }: SettingsProps) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localModel, setLocalModel] = useState(model);
  const [localAutoTranscribe, setLocalAutoTranscribe] = useState(autoTranscribe);

  return (
    <div className="settings">
      <div className="header">
        <button onClick={onBack}>← Back</button>
        <h2>Settings</h2>
      </div>

      <div className="form-group">
        <label>Groq API Key</label>
        <input
          type="password"
          value={localApiKey}
          onChange={(e) => setLocalApiKey(e.target.value)}
          placeholder="gsk_..."
        />
      </div>

      <div className="form-group">
        <label>Model</label>
        <select value={localModel} onChange={(e) => setLocalModel(e.target.value)}>
          <option value="whisper-large-v3-turbo">Whisper Large V3 Turbo (faster, cheaper)</option>
          <option value="whisper-large-v3">Whisper Large V3 (more accurate)</option>
        </select>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={localAutoTranscribe}
            onChange={(e) => setLocalAutoTranscribe(e.target.checked)}
          />
          Auto-transcribe after recording
        </label>
        <p className="hint">
          ⚠️ Transcription sends audio to Groq's servers for processing
        </p>
      </div>

      <button
        onClick={() =>
          onSave({ apiKey: localApiKey, model: localModel, autoTranscribe: localAutoTranscribe })
        }
      >
        Save Settings
      </button>
    </div>
  );
}
