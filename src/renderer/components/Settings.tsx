import React, { useState } from 'react';
import { ChevronLeft, Download, KeyRound, ShieldCheck } from 'lucide-react';
import {
  type LocalModelStatus,
  type TranscriptionIpcResult,
  type TranscriptionProvider,
} from '../../types/transcription';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';

interface SettingsProps {
  apiKey: string;
  model: string;
  provider: TranscriptionProvider;
  localModelStatus: LocalModelStatus;
  onInstallLocalModel: () => Promise<TranscriptionIpcResult>;
  onSave: (settings: {
    apiKey: string;
    model: string;
    transcriptionProvider: TranscriptionProvider;
  }) => Promise<void>;
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
  apiKey,
  model,
  provider,
  localModelStatus,
  onInstallLocalModel,
  onSave,
  onBack,
}: SettingsProps) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localModel, setLocalModel] = useState(model);
  const [localProvider, setLocalProvider] = useState<TranscriptionProvider>(provider);
  const [isInstallingModel, setIsInstallingModel] = useState(false);
  const [modelInstallFailed, setModelInstallFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const isLocal = localProvider === 'local';
  const canInstallModel = localModelStatus.state !== 'unavailable';
  const shouldRetryDownload = modelInstallFailed || localModelStatus.state === 'invalid';

  const installModel = async (): Promise<void> => {
    setIsInstallingModel(true);
    setModelInstallFailed(false);
    try {
      const result = await onInstallLocalModel();
      if (!result.success) {
        setModelInstallFailed(true);
      }
    } catch {
      setModelInstallFailed(true);
    } finally {
      setIsInstallingModel(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    if (isSaving) return;

    setIsSaving(true);
    try {
      await onSave({
        apiKey: localApiKey,
        model: localModel,
        transcriptionProvider: localProvider,
      });
    } finally {
      setIsSaving(false);
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
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                  <KeyRound className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Transcription</h2>
                  <p className="text-xs text-muted-foreground">
                    Choose where recorded audio is processed.
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="transcription-provider">Provider</Label>
                <Select
                  value={localProvider}
                  onValueChange={(value) => setLocalProvider(value as TranscriptionProvider)}
                >
                  <SelectTrigger id="transcription-provider" aria-label="Transcription provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local Whisper</SelectItem>
                    <SelectItem value="groq">Groq</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isLocal ? (
                <div className="space-y-3">
                  <div className="rounded-md bg-secondary/70 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Large V3 Turbo · about 547 MB</p>
                        <p className="text-xs text-muted-foreground">Whisper model</p>
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
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="groq-api-key">Groq API Key</Label>
                    <Input
                      id="groq-api-key"
                      type="password"
                      value={localApiKey}
                      onChange={(e) => setLocalApiKey(e.target.value)}
                      placeholder="gsk_..."
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="groq-model">Model</Label>
                    <Select value={localModel} onValueChange={setLocalModel}>
                      <SelectTrigger id="groq-model">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="whisper-large-v3-turbo">
                          Whisper Large V3 Turbo
                        </SelectItem>
                        <SelectItem value="whisper-large-v3">Whisper Large V3</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Turbo is faster and cheaper; Large V3 can be more accurate.
                    </p>
                  </div>
                </div>
              )}
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
                  {isLocal
                    ? 'Transcription runs on this Mac. Audio is not uploaded.'
                    : 'Transcription sends prepared audio to Groq for processing.'}
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      </ScrollArea>

      <Button
        className="w-full"
        onClick={() => void saveSettings()}
        disabled={isSaving}
        aria-busy={isSaving}
      >
        Save settings
      </Button>
      <p className="sr-only" aria-live="polite">
        {isSaving ? 'Saving settings' : ''}
      </p>
    </main>
  );
}
