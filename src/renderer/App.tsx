import React, { useCallback, useState, useEffect, useRef } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { TranscriptView } from './components/TranscriptView';
import { Settings } from './components/Settings';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { AudioCapture } from './audio-capture';
import { getRecordingPermissionNotice } from './recording-permissions';
import { type RecordingPermissionSnapshot } from '../types/recording-permissions';
import {
  type LocalModelStatus,
  type TranscriptionProgress,
  type TranscriptionProvider,
} from '../types/transcription';
import { type TranscriptionSettings } from '../types/settings';
import { getTranscriptionErrorMessage } from './transcription-ui';
import './styles.css';

type View = 'recordings' | 'transcript' | 'settings';

interface AppRecording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
}

function getErrorMessage(fallback: string): string {
  console.error('Renderer operation failed.');
  return fallback;
}

export default function App() {
  const [view, setView] = useState<View>('recordings');
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<AppRecording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<AppRecording | null>(null);
  const [settings, setSettings] = useState<{
    apiKey: string;
    model: string;
    transcriptionProvider: TranscriptionProvider;
  }>({ apiKey: '', model: 'whisper-large-v3-turbo', transcriptionProvider: 'local' });
  const [error, setError] = useState<string | null>(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgress | null>(null);
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelStatus>({ state: 'not-downloaded' });
  const [permissions, setPermissions] = useState<RecordingPermissionSnapshot | null>(null);
  const [permissionNoticeDismissed, setPermissionNoticeDismissed] = useState(false);

  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const activeTranscriptionIdRef = useRef<string | null>(null);

  const refreshRecordingPermissions = useCallback(async (): Promise<RecordingPermissionSnapshot> => {
    try {
      const result = await window.electronAPI.getRecordingPermissions();
      if (!result.success || !result.permissions) {
        throw new Error(result.error || 'Unable to check recording permissions');
      }
      setPermissions(result.permissions);
      return result.permissions;
    } catch {
      console.error('Renderer permission refresh failed.');
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
      } catch {
        console.error('Renderer settings load failed.');
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

  useEffect(() => {
    const unsubscribe = window.electronAPI.onTranscriptionProgress((progress) => {
      if (progress.recordingId === activeTranscriptionIdRef.current) {
        setTranscriptionProgress(progress);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const loadLocalModelStatus = async (): Promise<void> => {
      try {
        setLocalModelStatus(await window.electronAPI.getLocalModelStatus());
      } catch {
        console.error('Renderer local model status load failed.');
        setLocalModelStatus({ state: 'unavailable', reason: 'sidecar-missing' });
      }
    };

    void loadLocalModelStatus();
    return window.electronAPI.onLocalModelStatus(setLocalModelStatus);
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
    } catch {
      console.error('Renderer recordings load failed.');
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
    } catch {
      // Clean up if partially started
      audioCaptureRef.current?.stop();
      audioCaptureRef.current = null;
      console.error('Renderer recording start failed.');

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
    } catch {
      capture.stop();
      audioCaptureRef.current = null;
      console.error('Renderer recording file creation failed.');
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
    } catch {
      setError(getErrorMessage('Failed to stop recording'));
      // Still mark as not recording even if error
      setIsRecording(false);
    }
  };

  const handleTranscribe = async (id: string) => {
    const recording = recordings.find((r) => r.id === id);
    if (!recording) return;

    setError(null);
    activeTranscriptionIdRef.current = id;
    setTranscriptionProgress({ recordingId: id, stage: 'preparing-audio' });
    try {
      const result = await window.electronAPI.transcribe(recording.id);
      if (result.success) {
        // Refresh recordings list
        await loadRecordings();
      } else {
        setError(getTranscriptionErrorMessage(result));
      }
    } catch {
      setError(getErrorMessage('Transcription failed'));
    } finally {
      if (activeTranscriptionIdRef.current === id) {
        activeTranscriptionIdRef.current = null;
        setTranscriptionProgress(null);
      }
    }
  };

  const handleExport = async () => {
    if (!selectedRecording) return;

    setError(null);
    if (!selectedRecording.transcribed) {
      setError('No transcript available to export');
      return;
    }

    try {
      const result = await window.electronAPI.exportTranscript(selectedRecording.id, 'txt');
      if (!result.success) {
        setError('Export failed');
      }
    } catch {
      setError(getErrorMessage('Export failed'));
    }
  };

  const handleInstallLocalModel = async () => {
    const result = await window.electronAPI.installLocalModel();
    if (result.success) {
      setLocalModelStatus(await window.electronAPI.getLocalModelStatus());
    }
    return result;
  };

  const handleSaveSettings = async (newSettings: TranscriptionSettings): Promise<void> => {
    setError(null);
    try {
      const result = await window.electronAPI.saveConfig(newSettings);
      if (!result.success) {
        setError('Settings could not be saved. Your changes are still here. Try again.');
        return;
      }
      setSettings(newSettings);
      setView('recordings');
    } catch {
      setError(getErrorMessage('Failed to save settings'));
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
          provider={settings.transcriptionProvider}
          localModelStatus={localModelStatus}
          onInstallLocalModel={handleInstallLocalModel}
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
        transcriptionProgress={transcriptionProgress}
        localTranscriptionUnavailable={
          settings.transcriptionProvider === 'local' && localModelStatus.state === 'unavailable'
        }
        permissionNotice={permissionNoticeDismissed ? null : permissionNotice}
        onOpenPermissionSettings={handleOpenPermissionSettings}
        onDismissPermissionNotice={() => setPermissionNoticeDismissed(true)}
      />
    </>
  );
}
