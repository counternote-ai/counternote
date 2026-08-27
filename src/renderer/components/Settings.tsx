import React, { useState } from 'react';
import { ChevronLeft, Download, ShieldCheck } from 'lucide-react';
import { type LocalModelStatus, type TranscriptionIpcResult } from '../../types/transcription';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';

interface SettingsProps {
  localModelStatus: LocalModelStatus;
  onInstallLocalModel: () => Promise<TranscriptionIpcResult>;
  onBack: () => void;
}

function getLocalModelLabel(status: LocalModelStatus): string {
  switch (status.state) {
    case 'downloading':
      return `Downloading · ${status.percent ?? 0}%`;
    case 'ready':
      return 'Ready';
    case 'invalid':
      return 'Invalid model';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'Not downloaded';
  }
}

function getUnavailableExplanation(status: LocalModelStatus): string {
  return status.reason === 'unsupported-platform'
    ? 'Local Whisper is available on macOS Apple Silicon.'
    : 'Local Whisper is unavailable because its sidecar is not installed.';
}

export function Settings({
  localModelStatus,
  onInstallLocalModel,
  onBack,
}: SettingsProps): React.JSX.Element {
  const [isInstallingModel, setIsInstallingModel] = useState(false);
  const [modelInstallFailed, setModelInstallFailed] = useState(false);

  const canInstallModel = localModelStatus.state !== 'unavailable';
  const shouldRetryDownload = modelInstallFailed || localModelStatus.state === 'invalid';

  const installModel = async (): Promise<void> => {
    setIsInstallingModel(true);
    setModelInstallFailed(false);
    try {
      const result = await onInstallLocalModel();
      if (!result.success) setModelInstallFailed(true);
    } catch {
      setModelInstallFailed(true);
    } finally {
      setIsInstallingModel(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="flex items-center gap-3">
        <Button variant="outline" size="pill" onClick={onBack}>
          <ChevronLeft />
          Back
        </Button>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
      </header>

      <ScrollArea className="app-scroll-shadow min-h-0 flex-1 pr-1">
        <section className="space-y-3 pb-1">
          <Card>
            <CardContent className="space-y-4 p-4">
              <div>
                <h2 className="text-sm font-semibold">Local transcription</h2>
                <p className="text-xs text-muted-foreground">
                  Download the models once to transcribe recordings locally.
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="rounded-md bg-secondary/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Large V3 Turbo · about 548 MB</p>
                      <p className="text-xs text-muted-foreground">
                        Whisper and speech detection models
                      </p>
                    </div>
                    <Badge variant={localModelStatus.state === 'ready' ? 'ready' : 'pending'}>
                      {getLocalModelLabel(localModelStatus)}
                    </Badge>
                  </div>
                  {localModelStatus.state === 'unavailable' && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {getUnavailableExplanation(localModelStatus)}
                    </p>
                  )}
                </div>

                {localModelStatus.state !== 'ready' && canInstallModel && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void installModel()}
                    disabled={isInstallingModel || localModelStatus.state === 'downloading'}
                    aria-busy={isInstallingModel || localModelStatus.state === 'downloading'}
                  >
                    <Download />
                    {isInstallingModel || localModelStatus.state === 'downloading'
                      ? 'Downloading model'
                      : shouldRetryDownload
                        ? 'Retry download'
                        : 'Download model'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex gap-3 p-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">Privacy</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Transcription runs on this Mac. Audio is not uploaded.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </ScrollArea>
    </main>
  );
}
