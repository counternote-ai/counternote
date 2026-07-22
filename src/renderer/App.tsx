import React, { useCallback, useState, useEffect, useRef } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { TranscriptView } from './components/TranscriptView';
import { Settings } from './components/Settings';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { AudioCapture } from './audio-capture';
import { getRecordingPermissionNotice } from './recording-permissions';
import { type RecordingPermissionSnapshot } from '../types/recording-permissions';
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
  const [permissions, setPermissions] = useState<RecordingPermissionSnapshot | null>(null);
  const [permissionNoticeDismissed, setPermissionNoticeDismissed] = useState(false);

  const audioCaptureRef = useRef<AudioCapture | null>(null);

  const refreshRecordingPermissions = useCallback(async (): Promise<RecordingPermissionSnapshot> => {
    try {
      const result = await window.electronAPI.getRecordingPermissions();
      if (!result.success || !result.permissions) {
        throw new Error(result.error || 'Unable to check recording permissions');
      }
      setPermissions(result.permissions);
      return result.permissions;
    } catch (err) {
      console.error('Failed to check recording permissions:', err);
      const unknownPermissions: RecordingPermissionSnapshot = {
        screen: 'unknown',
        microphone: 'unknown',
        permissionOwnerName: 'Electron',
        canAttemptRecording: true,
      };
      setPermissions(unknownPermissions);
      return unknownPermissions;
    }
  }, []);

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

  useEffect(() => {
    void refreshRecordingPermissions();

    const handleFocus = () => {
      void refreshRecordingPermissions();
    };
    window.addEventListener('focus', handleFocus);

    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshRecordingPermissions]);

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
    const currentPermissions = await refreshRecordingPermissions();
    if (!currentPermissions.canAttemptRecording) {
      setPermissionNoticeDismissed(false);
      return;
    }

    let capture: AudioCapture;
    try {
      // Start audio capture first (requests media permissions)
      capture = new AudioCapture();
      await capture.start();
      audioCaptureRef.current = capture;
    } catch (err: unknown) {
      // Clean up if partially started
      audioCaptureRef.current?.stop();
      audioCaptureRef.current = null;
      console.error('Failed to start audio capture:', err);

      // A prompt may have changed permission state while capture was starting.
      const updatedPermissions = await refreshRecordingPermissions();
      if (!updatedPermissions.canAttemptRecording) {
        setPermissionNoticeDismissed(false);
        setError(null);
      } else {
        setError('Unable to start recording. Check your recording permissions and try again.');
      }
      return;
    }

    try {
      // Then create the WAV file on the main process.
      const result = await window.electronAPI.startRecording();
      if (!result.success) {
        throw new Error('Unable to create recording file');
      }

      setIsRecording(true);
      // Notify main process for tray update
      window.electronAPI.sendAudioData(new ArrayBuffer(0)); // noop, just to ensure channel is warm
    } catch (err: unknown) {
      capture.stop();
      audioCaptureRef.current = null;
      console.error('Failed to create recording file:', err);
      setError('Unable to create the recording file. Check available disk space and try again.');
    }
  };

  const permissionNotice = permissions
    ? getRecordingPermissionNotice(permissions)
    : null;

  const handleOpenPermissionSettings = async () => {
    if (!permissionNotice?.settingsPermission) return;

    try {
      const result = await window.electronAPI.openRecordingPermissionSettings(
        permissionNotice.settingsPermission
      );
      if (!result.success) {
        setError('Unable to open System Settings. Open System Settings → Privacy & Security manually.');
      }
    } catch {
      setError('Unable to open System Settings. Open System Settings → Privacy & Security manually.');
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
        permissionNotice={permissionNoticeDismissed ? null : permissionNotice}
        onOpenPermissionSettings={handleOpenPermissionSettings}
        onDismissPermissionNotice={() => setPermissionNoticeDismissed(true)}
      />
    </>
  );
}
