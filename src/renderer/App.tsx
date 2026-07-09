import React, { useState, useEffect, useRef } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { TranscriptView } from './components/TranscriptView';
import { Settings } from './components/Settings';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { AudioCapture } from './audio-capture';
import './styles.css';

type View = 'recordings' | 'transcript' | 'settings';

interface AppRecording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  audioPath: string;
  transcriptPath?: string;
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function App() {
  const [view, setView] = useState<View>('recordings');
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<AppRecording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<AppRecording | null>(null);
  const [settings, setSettings] = useState({ apiKey: '', model: 'whisper-large-v3-turbo', autoTranscribe: false });
  const [error, setError] = useState<string | null>(null);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);

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
    } catch (err: unknown) {
      // User may have denied media permissions
      setError(getErrorMessage(err, 'Failed to start audio capture'));
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
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to stop recording'));
      // Still mark as not recording even if error
      setIsRecording(false);
    }
  };

  const handleTranscribe = async (id: string) => {
    const recording = recordings.find((r) => r.id === id);
    if (!recording) return;

    setError(null);
    setTranscribingId(id);
    try {
      const result = await window.electronAPI.transcribe(recording.audioPath);
      if (result.success) {
        // Refresh recordings list
        await loadRecordings();
      } else {
        setError(result.error || 'Transcription failed');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Transcription failed'));
    } finally {
      setTranscribingId(null);
    }
  };

  const handleExport = async () => {
    if (!selectedRecording) return;

    setError(null);
    if (!selectedRecording.transcriptPath) {
      setError('No transcript available to export');
      return;
    }

    try {
      const result = await window.electronAPI.exportTranscript(selectedRecording.transcriptPath, 'txt');
      if (!result.success) {
        setError(result.error || 'Export failed');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Export failed'));
    }
  };

  const handleSaveSettings = async (newSettings: { apiKey: string; model: string; autoTranscribe: boolean }) => {
    setError(null);
    try {
      await window.electronAPI.saveConfig(newSettings);
      setSettings(newSettings);
      setView('recordings');
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to save settings'));
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
    <Alert variant="destructive" className="fixed left-4 right-4 top-4 z-50 shadow-md">
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>{error}</span>
        <Button variant="ghost" size="sm" onClick={() => setError(null)}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
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
          duration={selectedRecording.duration}
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
        transcribingId={transcribingId}
      />
    </>
  );
}
