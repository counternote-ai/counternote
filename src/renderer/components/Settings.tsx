import React, { useState } from 'react';
import { ChevronLeft, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';

interface SettingsProps {
  apiKey: string;
  model: string;
  onSave: (settings: { apiKey: string; model: string }) => void;
  onBack: () => void;
}

export function Settings({ apiKey, model, onSave, onBack }: SettingsProps) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localModel, setLocalModel] = useState(model);

  return (
    <main className="app-shell">
      <header className="flex items-center justify-between gap-3">
        <Button variant="outline" size="pill" onClick={onBack}>
          <ChevronLeft />
          Back
        </Button>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
      </header>

      <section className="min-h-0 flex-1 space-y-3">
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <KeyRound className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Transcription</h2>
                <p className="text-xs text-muted-foreground">Groq settings for post-interview transcripts.</p>
              </div>
            </div>

            <Separator />

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
                  <SelectItem value="whisper-large-v3-turbo">Whisper Large V3 Turbo</SelectItem>
                  <SelectItem value="whisper-large-v3">Whisper Large V3</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Turbo is faster and cheaper; Large V3 can be more accurate.
              </p>
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
                Audio stays local until transcription runs. When transcription starts, audio is sent to Groq for processing.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      <Button
        className="w-full"
        onClick={() => onSave({ apiKey: localApiKey, model: localModel })}
      >
        Save settings
      </Button>
    </main>
  );
}
