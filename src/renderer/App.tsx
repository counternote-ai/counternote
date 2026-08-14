import React, { useCallback, useState, useEffect, useRef } from 'react';
import { ControlPanel } from './components/ControlPanel';
import { TranscriptView } from './components/TranscriptView';
import { Settings } from './components/Settings';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { getRecordingPermissionNotice } from './recording-permissions';
import { type RecordingPermissionSnapshot } from '../types/recording-permissions';
import {
  type LocalModelStatus,
  type TranscriptionProgress,
  type TranscriptionProvider,
} from '../types/transcription';
import { type TranscriptionSettings } from '../types/settings';
import { getTranscriptionErrorMessage } from './transcription-ui';
import {
  toRecordingHealthView,
  toStartErrorMessage,
  toStopFeedback,
  type RecordingHealthView,
} from './native-capture-view-model';
import './styles.css';

type View = 'recordings' | 'transcript' | 'settings';

interface AppRecording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
  captureStatus?: 'legacy' | 'complete' | 'interrupted';
  interruptions?: Array<{
    channel: string;
    startMs: number;
    endMs: number;
    recovered: boolean;
    reason: string;
  }>;
}

function getErrorMessage(fallback: string): string {
  console.error('Renderer operation failed.');
  return fallback;
}

export default function App() {
  const [view, setView] = useState<View>('recordings');
  const [recordings, setRecordings] = useState<AppRecording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<AppRecording | null>(null);
  const [settings, setSettings] = useState<{
    apiKey: string;
    model: string;
    transcriptionProvider: TranscriptionProvider;
  }>({ apiKey: '', model: 'whisper-large-v3-turbo', transcriptionProvider: 'local' });
  const [error, setError] = useState<string | null>(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgress | null>(
    null,
  );
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelStatus>({
    state: 'not-downloaded',
  });
  const [permissions, setPermissions] = useState<RecordingPermissionSnapshot | null>(null);
  const [permissionNoticeDismissed, setPermissionNoticeDismissed] = useState(false);
  const [permissionEscalated, setPermissionEscalated] = useState(false);

  /* ── Native capture state ─────────────────────────────────── */
  const [statusSnapshot, setStatusSnapshot] = useState<RecordingStatusSnapshot | null>(null);
  const [recoveryItems, setRecoveryItems] = useState<RecordingRecoveryItem[]>([]);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);

  const activeTranscriptionIdRef = useRef<string | null>(null);
  const recordingWasActiveRef = useRef(false);

  const refreshRecordingPermissions =
    useCallback(async (): Promise<RecordingPermissionSnapshot> => {
      try {
        const result = await window.electronAPI.getRecordingPermissions();
        if (!result.success || !result.permissions) {
          throw new Error(result.error || 'Unable to check recording permissions');
        }
        setPermissions(result.permissions);
        if (result.permissions.canAttemptRecording) {
          setPermissionEscalated(false);
        }
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
    window.electronAPI.onOpenSettings(() => {
      setView('settings');
    });
  }, []);

  /* ── Subscribe to native capture status ───────────────────── */
  useEffect(() => {
    const unsubscribe = window.electronAPI.onRecordingStatus((snapshot) => {
      const finishedRecording = recordingWasActiveRef.current && snapshot.state === 'idle';
      recordingWasActiveRef.current = snapshot.state !== 'idle';
      setStatusSnapshot(snapshot);
      if (finishedRecording) {
        void loadRecordings();
        void window.electronAPI
          .recordingListRecovery()
          .then(setRecoveryItems)
          .catch(() => undefined);
      }
    });
    return unsubscribe;
  }, []);

  /* ── Load recovery items on mount ─────────────────────────── */
  useEffect(() => {
    const loadRecovery = async () => {
      try {
        const items = await window.electronAPI.recordingListRecovery();
        setRecoveryItems(items);
      } catch {
        console.error('Renderer recovery list load failed.');
      }
    };
    void loadRecovery();
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
      setPermissionEscalated(true);
      return;
    }

    try {
      const result = await window.electronAPI.recordingStart();
      if (!result.ok) {
        const message = toStartErrorMessage(result);
        if (message) setError(message);
      }
    } catch {
      console.error('Renderer recording start failed.');
      setError('Unable to start recording. Please try again.');
    }
  };

  const handleStopRecording = async () => {
    setError(null);
    try {
      const result = await window.electronAPI.recordingStop();
      const feedback = toStopFeedback(result);
      if (feedback) setError(feedback);
      await loadRecordings();
      // Refresh recovery list after stop
      try {
        const items = await window.electronAPI.recordingListRecovery();
        setRecoveryItems(items);
      } catch {
        // Non-fatal
      }
    } catch {
      setError(getErrorMessage('Failed to stop recording'));
    }
  };

  const handleCancelRecording = async () => {
    setError(null);
    try {
      await window.electronAPI.recordingCancel();
    } catch {
      console.error('Renderer recording cancel failed.');
    }
  };

  const handleRecover = async (id: string) => {
    setError(null);
    setRecoveringId(id);
    try {
      const result = await window.electronAPI.recordingRecover(id);
      if (result.outcome === 'recovered' || result.outcome === 'recovered-with-retained-source') {
        // Refresh recovery list and recordings
        const [items] = await Promise.all([
          window.electronAPI.recordingListRecovery(),
          loadRecordings(),
        ]);
        setRecoveryItems(items);
      } else if (result.outcome === 'recovery-failed') {
        setError('Recovery failed. The recording could not be repaired.');
      } else if (result.outcome === 'busy') {
        setError('A recording operation is in progress. Try again after it completes.');
      } else if (result.outcome === 'not-found') {
        setError('The recording could not be found.');
      } else if (result.outcome === 'not-recoverable') {
        setError('This recording cannot be recovered.');
      }
    } catch {
      setError(getErrorMessage('Recovery failed'));
    } finally {
      setRecoveringId(null);
    }
  };

  const handleTrashRecovery = async (id: string) => {
    setError(null);
    try {
      const result = await window.electronAPI.recordingTrashRecovery(id);
      if (result.outcome === 'trashed') {
        // Refresh recovery list
        const items = await window.electronAPI.recordingListRecovery();
        setRecoveryItems(items);
      } else if (result.outcome === 'trash-failed') {
        setError('Could not move the recording to Trash.');
      } else if (result.outcome === 'busy') {
        setError('A recording operation is in progress. Try again after it completes.');
      }
    } catch {
      setError(getErrorMessage('Could not move the recording to Trash.'));
    }
  };

  const permissionNotice = permissions ? getRecordingPermissionNotice(permissions) : null;

  const handleOpenPermissionSettings = async () => {
    if (!permissionNotice?.settingsPermission) return;

    try {
      const result = await window.electronAPI.openRecordingPermissionSettings(
        permissionNotice.settingsPermission,
      );
      if (!result.success) {
        setError(
          'Unable to open System Settings. Open System Settings → Privacy & Security manually.',
        );
      }
    } catch {
      setError(
        'Unable to open System Settings. Open System Settings → Privacy & Security manually.',
      );
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

  /* ── Derived native capture state ─────────────────────────── */
  const controllerState = statusSnapshot?.state ?? 'idle';
  const isRecording = controllerState === 'recording';
  const isStarting = controllerState === 'starting';
  const isFinishing = controllerState === 'finishing';
  const healthView: RecordingHealthView | null = statusSnapshot
    ? toRecordingHealthView(statusSnapshot)
    : null;

  // Recoverable error banner: inline at the top of the frame so it never
  // covers the current task or header actions.
  const ErrorBanner = error ? (
    <Alert variant="destructive">
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
      <div className="app-frame">
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
      </div>
    );
  }

  if (view === 'transcript' && selectedRecording) {
    return (
      <div className="app-frame">
        {ErrorBanner}
        <TranscriptView
          title={selectedRecording.title}
          duration={selectedRecording.duration}
          segments={selectedRecording.segments || []}
          onBack={() => setView('recordings')}
          onExport={handleExport}
        />
      </div>
    );
  }

  return (
    <div className="app-frame">
      {ErrorBanner}
      <ControlPanel
        recordings={recordings}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
        onCancelRecording={handleCancelRecording}
        onTranscribe={handleTranscribe}
        onSelectRecording={handleSelectRecording}
        onOpenSettings={() => setView('settings')}
        isRecording={isRecording}
        isStarting={isStarting}
        isFinishing={isFinishing}
        healthView={healthView}
        recoveryItems={recoveryItems}
        recoveringId={recoveringId}
        onRecover={handleRecover}
        onTrashRecovery={handleTrashRecovery}
        transcriptionProgress={transcriptionProgress}
        localTranscriptionUnavailable={
          settings.transcriptionProvider === 'local' && localModelStatus.state === 'unavailable'
        }
        permissionNotice={permissionNoticeDismissed ? null : permissionNotice}
        permissionEscalated={permissionEscalated}
        onOpenPermissionSettings={handleOpenPermissionSettings}
        onDismissPermissionNotice={() => setPermissionNoticeDismissed(true)}
      />
    </div>
  );
}
