import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { TranscriptView } from './components/TranscriptView';
import { Settings } from './components/Settings';
import { AudioCapture } from './audio-capture';
import './styles.css';

type View = 'recordings' | 'transcript' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('recordings');
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<any[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<any>(null);
  const [settings, setSettings] = useState({ apiKey: '', model: 'whisper-large-v3-turbo', autoTranscribe: false });
  const [error, setError] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const audioCaptureRef = useRef<AudioCapture | null>(null);

  // Load settings from main process on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const result = await window.electronAPI.loadConfig();
        if (result.success && result.config) {
          setSettings(result.config);
        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    };
    loadSettings();
  }, []);

  // Load recordings on mount
  useEffect(() => {
    loadRecordings();
  }, []);

  // Listen for tray events
  useEffect(() => {
    window.electronAPI.onStopRecording(() => {
      handleStopRecording();
    });
    window.electronAPI.onOpenSettings(() => {
      setView('settings');
    });
  }, []);

  const loadRecordings = async () => {
    try {
      const result = await window.electronAPI.listRecordings();
      if (result.success) {
        setRecordings(result.recordings);
      }
    } catch (err) {
      console.error('Failed to load recordings:', err);
    }
  };

  const handleStartRecording = async () => {
    setError(null);
    try {
      // Start audio capture first (requests media permissions)
      const capture = new AudioCapture();
      await capture.start();
      audioCaptureRef.current = capture;

      // Then create the WAV file on main process
      const result = await window.electronAPI.startRecording();
      if (result.success) {
        setIsRecording(true);
        // Notify main process for tray update
        window.electronAPI.sendAudioData(new ArrayBuffer(0)); // noop, just to ensure channel is warm
      } else {
        // WAV creation failed, stop capture
        capture.stop();
        audioCaptureRef.current = null;
        setError('Failed to start recording');
      }
    } catch (err: any) {
      // User may have denied media permissions
      const message = err?.message || 'Failed to start audio capture';
      setError(message);
      // Clean up if partially started
      audioCaptureRef.current?.stop();
      audioCaptureRef.current = null;
    }
  };

  const handleStopRecording = async () => {
    setError(null);
    try {
      // Stop audio capture first
      audioCaptureRef.current?.stop();
      audioCaptureRef.current = null;

      // Then finalize the WAV file
      const result = await window.electronAPI.stopRecording();
      if (result.success) {
        setIsRecording(false);
        // Refresh recordings list
        await loadRecordings();
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to stop recording');
      // Still mark as not recording even if error
      setIsRecording(false);
    }
  };

  const handleTranscribe = async (id: string) => {
    const recording = recordings.find((r) => r.id === id);
    if (!recording) return;

    setError(null);
    setIsTranscribing(true);
    try {
      const result = await window.electronAPI.transcribe(recording.audioPath);
      if (result.success) {
        // Refresh recordings list
        await loadRecordings();
      } else {
        setError(result.error || 'Transcription failed');
      }
    } catch (err: any) {
      setError(err?.message || 'Transcription failed');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleExport = async () => {
    if (!selectedRecording) return;

    setError(null);
    try {
      const result = await window.electronAPI.exportTranscript(selectedRecording.transcriptPath, 'txt');
      if (!result.success) {
        setError(result.error || 'Export failed');
      }
    } catch (err: any) {
      setError(err?.message || 'Export failed');
    }
  };

  const handleSaveSettings = async (newSettings: { apiKey: string; model: string; autoTranscribe: boolean }) => {
    setError(null);
    try {
      await window.electronAPI.saveConfig(newSettings);
      setSettings(newSettings);
      setView('recordings');
    } catch (err: any) {
      setError(err?.message || 'Failed to save settings');
    }
  };

  const handleSelectRecording = (id: string) => {
    const recording = recordings.find((r) => r.id === id);
    if (recording) {
      setSelectedRecording(recording);
      setView('transcript');
    }
  };

  // Error banner component
  const ErrorBanner = error ? (
    <div className="error-banner">
      <span>{error}</span>
      <button onClick={() => setError(null)}>Dismiss</button>
    </div>
  ) : null;

  if (view === 'settings') {
    return (
      <>
        {ErrorBanner}
        <Settings
          apiKey={settings.apiKey}
          model={settings.model}
          autoTranscribe={settings.autoTranscribe}
          onSave={handleSaveSettings}
          onBack={() => setView('recordings')}
        />
      </>
    );
  }

  if (view === 'transcript' && selectedRecording) {
    return (
      <>
        {ErrorBanner}
        <TranscriptView
          title={selectedRecording.title}
          segments={selectedRecording.segments || []}
          onBack={() => setView('recordings')}
          onExport={handleExport}
        />
      </>
    );
  }

  return (
    <>
      {ErrorBanner}
      <ControlPanel
        recordings={recordings}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
        onTranscribe={handleTranscribe}
        onSelectRecording={handleSelectRecording}
        onOpenSettings={() => setView('settings')}
        isRecording={isRecording}
        isTranscribing={isTranscribing}
      />
    </>
  );
}
