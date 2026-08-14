import React from 'react';
import { FileText, LoaderCircle, Mic, Plus, Settings, Square, X } from 'lucide-react';
import { Badge } from './ui/badge';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { formatDuration, getRecordingStatus, type RecordingStatusTone } from '../recording-utils';
import { getTranscriptionStageLabel } from '../transcription-ui';
import { cn } from '@/lib/utils';
import { type RecordingPermissionNotice } from '../recording-permissions';
import { type TranscriptionProgress } from '../../types/transcription';
import { RecordingHealth } from './RecordingHealth';
import { RecordingRecovery } from './RecordingRecovery';
import {
  formatBytes,
  type RecordingHealthView,
  type RecoveryItemView,
} from '../native-capture-view-model';

interface Recording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  captureStatus?: 'legacy' | 'complete' | 'interrupted';
}

interface ControlPanelProps {
  recordings: Recording[];
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording?: () => void;
  onTranscribe: (id: string) => void;
  onSelectRecording: (id: string) => void;
  onOpenSettings: () => void;
  isRecording: boolean;
  isStarting?: boolean;
  isFinishing?: boolean;
  healthView?: RecordingHealthView | null;
  recoveryItems?: RecordingRecoveryItem[];
  recoveringId?: string | null;
  onRecover?: (id: string) => void;
  onTrashRecovery?: (id: string) => void;
  transcriptionProgress?: TranscriptionProgress | null;
  localTranscriptionUnavailable?: boolean;
  permissionNotice?: RecordingPermissionNotice | null;
  permissionEscalated?: boolean;
  onOpenPermissionSettings: () => void;
  onDismissPermissionNotice: () => void;
}

const statusVariant: Record<RecordingStatusTone, 'ready' | 'pending' | 'loading'> = {
  ready: 'ready',
  pending: 'pending',
  loading: 'loading',
};

export function ControlPanel({
  recordings,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onTranscribe,
  onSelectRecording,
  onOpenSettings,
  isRecording,
  isStarting = false,
  isFinishing = false,
  healthView,
  recoveryItems = [],
  recoveringId = null,
  onRecover,
  onTrashRecovery,
  transcriptionProgress,
  localTranscriptionUnavailable = false,
  permissionNotice,
  permissionEscalated = false,
  onOpenPermissionSettings,
  onDismissPermissionNotice,
}: ControlPanelProps) {
  const recoveryViews: RecoveryItemView[] = recoveryItems.map((item) => {
    const base: RecoveryItemView = {
      id: item.id,
      dateLabel: new Date(item.createdAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
      sizeLabel: formatBytes(item.bytes),
      stateLabel:
        item.state === 'recoverable'
          ? 'Partial audio can be recovered'
          : 'Partial audio could not be repaired',
      state: item.state,
    };
    if (recoveringId === item.id) {
      return { ...base, stateLabel: 'Recovering partial recording…', state: 'recovering' as const };
    }
    return base;
  });

  const recoveryNotice =
    recoveryItems.length === 0
      ? 'No recordings to recover'
      : recoveryItems.length === 1
        ? `1 recording, ${formatBytes(sumBytes(recoveryItems))}`
        : `${recoveryItems.length} recordings, ${formatBytes(sumBytes(recoveryItems))}`;

  return (
    <TooltipProvider>
      <main className="app-shell">
        <header className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Interview Copilot</p>
              <h1 className="truncate text-xl font-semibold tracking-normal text-foreground">
                Past Interviews
              </h1>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onOpenSettings}
                  aria-label="Open settings"
                >
                  <Settings />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {recordings.length === 1
                ? '1 saved interview'
                : `${recordings.length} saved interviews`}
            </p>
            {isStarting && onCancelRecording ? (
              <Button variant="outline" size="pill" onClick={onCancelRecording}>
                <X />
                Cancel
              </Button>
            ) : isRecording || isFinishing ? (
              <Button
                variant="destructive"
                size="pill"
                onClick={onStopRecording}
                disabled={isFinishing}
              >
                <Square />
                Stop
              </Button>
            ) : (
              <Button variant="outline" size="pill" onClick={onStartRecording}>
                <Plus />
                Record
              </Button>
            )}
          </div>
        </header>

        {healthView && (isStarting || isRecording || isFinishing) && (
          <RecordingHealth view={healthView} />
        )}

        {permissionNotice && (
          <Alert
            variant={
              permissionEscalated || permissionNotice.tone === 'error' ? 'destructive' : 'default'
            }
          >
            <AlertDescription className="space-y-3">
              <p>{permissionNotice.message}</p>
              <div className="flex flex-wrap gap-2">
                {permissionNotice.settingsPermission && (
                  <Button variant="outline" size="sm" onClick={onOpenPermissionSettings}>
                    Open System Settings
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onDismissPermissionNotice}>
                  Dismiss
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {recoveryItems.length > 0 && onRecover && onTrashRecovery && (
          <RecordingRecovery
            notice={recoveryNotice}
            items={recoveryViews}
            onRecover={onRecover}
            onTrash={onTrashRecovery}
            disabled={isRecording || isStarting}
          />
        )}

        {recordings.length === 0 && !isStarting && !isRecording ? (
          <Card className="flex flex-1 items-center justify-center border-dashed bg-card/80">
            <CardContent className="flex max-w-64 flex-col items-center gap-3 p-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <Mic className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-semibold">No recordings yet</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Start a recording when your next interview begins. Transcripts will appear here
                  afterward.
                </p>
              </div>
              <Button
                variant="outline"
                size="pill"
                onClick={onStartRecording}
                disabled={isRecording}
              >
                <Plus />
                Start recording
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ScrollArea className="app-scroll-shadow min-h-0 flex-1 pr-1">
            <div className="space-y-3 pb-1">
              {recordings.map((rec) => {
                const progress =
                  transcriptionProgress?.recordingId === rec.id ? transcriptionProgress : null;
                const isTranscribing = progress !== null;
                const status = getRecordingStatus({
                  transcribed: rec.transcribed,
                  transcriptionProgress: progress,
                });
                const canOpen = rec.transcribed;
                const isInterrupted = rec.captureStatus === 'interrupted';

                return (
                  <Card
                    key={rec.id}
                    className={cn(
                      'overflow-hidden transition-colors',
                      canOpen && 'hover:bg-card/90',
                    )}
                    aria-busy={isTranscribing || undefined}
                  >
                    <CardContent className="p-0">
                      <button
                        type="button"
                        className="block w-full cursor-pointer p-4 text-left disabled:cursor-default"
                        onClick={() => canOpen && onSelectRecording(rec.id)}
                        disabled={!canOpen}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <h2 className="truncate text-sm font-semibold text-foreground">
                                {rec.title}
                              </h2>
                              {isInterrupted && <Badge variant="destructive">Interrupted</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {formatDuration(rec.duration)}
                            </p>
                          </div>
                          <Badge variant={statusVariant[status.tone]}>{status.label}</Badge>
                        </div>
                      </button>

                      {!rec.transcribed && !isInterrupted && (
                        <div className="border-t border-border px-4 py-3">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="w-full"
                            onClick={() => onTranscribe(rec.id)}
                            disabled={
                              Boolean(transcriptionProgress) || localTranscriptionUnavailable
                            }
                          >
                            {isTranscribing && <LoaderCircle className="animate-spin" />}
                            {localTranscriptionUnavailable
                              ? 'Local transcription unavailable'
                              : isTranscribing && progress
                                ? getTranscriptionStageLabel(progress)
                                : 'Transcribe audio'}
                          </Button>
                          {localTranscriptionUnavailable && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Local Whisper is unavailable. Check Settings for details.
                            </p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </main>
    </TooltipProvider>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function sumBytes(items: RecordingRecoveryItem[]): number {
  let total = 0;
  for (const item of items) {
    const safe = Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0;
    if (total <= Number.MAX_SAFE_INTEGER - safe) {
      total += safe;
    } else {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  return total;
}
