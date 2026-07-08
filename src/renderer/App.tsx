import React, { useState, useEffect } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { TranscriptView } from './components/TranscriptView';
import { Settings } from './components/Settings';
import './styles.css';

type View = 'recordings' | 'transcript' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('recordings');
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<any>(null);
  const [settings, setSettings] = useState({ apiKey: '', model: 'whisper-large-v3-turbo', autoTranscribe: false });

  // Load recordings on mount
  useEffect(() => {
    const loadRecordings = async () => {
      const result = await window.electronAPI.listRecordings();
      if (result.success) {
        setRecordings(result.recordings);
      }
    };
    loadRecordings();
  }, []);

  const handleStartRecording = async () => {
    const result = await window.electronAPI.startRecording();
    if (result.success) {
      setIsRecording(true);
    }
  };

  const handleStopRecording = async () => {
    const result = await window.electronAPI.stopRecording();
    if (result.success) {
      setIsRecording(false);
      // Refresh recordings list
      const recordingsResult = await window.electronAPI.listRecordings();
      if (recordingsResult.success) {
        setRecordings(recordingsResult.recordings);
      }
    }
  };

  const handleTranscribe = async (id: string) => {
    const recording = recordings.find((r) => r.id === id);
    if (recording) {
      const result = await window.electronAPI.transcribe(recording.audioPath);
      if (result.success) {
        // Refresh recordings list
        const recordingsResult = await window.electronAPI.listRecordings();
        if (recordingsResult.success) {
          setRecordings(recordingsResult.recordings);
        }
      }
    }
  };

  const handleExport = async () => {
    if (selectedRecording) {
      await window.electronAPI.exportTranscript(selectedRecording.transcriptPath, 'txt');
    }
  };

  if (view === 'settings') {
    return (
      <Settings
        apiKey={settings.apiKey}
        model={settings.model}
        autoTranscribe={settings.autoTranscribe}
        onSave={(newSettings) => {
          setSettings(newSettings);
          setView('recordings');
        }}
        onBack={() => setView('recordings')}
      />
    );
  }

  if (view === 'transcript' && selectedRecording) {
    return (
      <TranscriptView
        title={selectedRecording.title}
        segments={selectedRecording.segments}
        onBack={() => setView('recordings')}
        onExport={handleExport}
      />
    );
  }

  return (
    <ControlPanel
      recordings={recordings}
      onStartRecording={handleStartRecording}
      onStopRecording={handleStopRecording}
      onTranscribe={handleTranscribe}
      onSelectRecording={(id) => {
        setSelectedRecording(recordings.find((r) => r.id === id));
        setView('transcript');
      }}
      isRecording={isRecording}
    />
  );
}
