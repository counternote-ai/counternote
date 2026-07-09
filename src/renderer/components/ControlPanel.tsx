import React from 'react';
import { FileText, LoaderCircle, Mic, Plus, Settings, Square } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { formatDuration, getRecordingStatus, type RecordingStatusTone } from '../recording-utils';

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
  transcribingId?: string | null;
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
  onTranscribe,
  onSelectRecording,
  onOpenSettings,
  isRecording,
  transcribingId,
}: ControlPanelProps) {
  return (
    <TooltipProvider>
      <main className="app-shell">
        <header className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Interview Copilot</p>
              <h1 className="truncate text-xl font-semibold tracking-normal text-foreground">Past Interviews</h1>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="Open settings">
                  <Settings />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {recordings.length === 1 ? '1 saved interview' : `${recordings.length} saved interviews`}
            </p>
            {isRecording ? (
              <Button variant="destructive" size="pill" onClick={onStopRecording}>
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

        {recordings.length === 0 ? (
          <Card className="flex flex-1 items-center justify-center border-dashed bg-card/80">
            <CardContent className="flex max-w-64 flex-col items-center gap-3 p-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <Mic className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-semibold">No recordings yet</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Start a recording when your next interview begins. Transcripts will appear here afterward.
                </p>
              </div>
              <Button variant="outline" size="pill" onClick={onStartRecording} disabled={isRecording}>
                <Plus />
                Start recording
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ScrollArea className="app-scroll-shadow min-h-0 flex-1 pr-1">
            <div className="space-y-3 pb-1">
              {recordings.map((rec) => {
                const isTranscribing = transcribingId === rec.id;
                const status = getRecordingStatus({ transcribed: rec.transcribed, isTranscribing });
                const canOpen = rec.transcribed && !isTranscribing;

                return (
                  <Card key={rec.id} className="overflow-hidden transition-colors hover:bg-card/90">
                    <CardContent className="p-0">
                      <button
                        type="button"
                        className="block w-full cursor-pointer p-4 text-left disabled:cursor-default"
                        onClick={() => canOpen && onSelectRecording(rec.id)}
                        disabled={!canOpen}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <h2 className="truncate text-sm font-semibold text-foreground">{rec.title}</h2>
                            </div>
                            <p className="text-xs text-muted-foreground">{formatDuration(rec.duration)}</p>
                          </div>
                          <Badge variant={statusVariant[status.tone]}>{status.label}</Badge>
                        </div>
                      </button>

                      {!rec.transcribed && (
                        <div className="border-t border-border px-4 py-3">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="w-full"
                            onClick={() => onTranscribe(rec.id)}
                            disabled={Boolean(transcribingId)}
                          >
                            {isTranscribing && <LoaderCircle className="animate-spin" />}
                            {isTranscribing ? 'Transcribing' : 'Transcribe audio'}
                          </Button>
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
