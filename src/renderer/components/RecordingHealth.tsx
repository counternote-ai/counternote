import React from 'react';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';
import type { RecordingHealthView, HealthTone } from '../native-capture-view-model';

interface RecordingHealthProps {
  view: RecordingHealthView;
}

const toneVariant: Record<HealthTone, 'ready' | 'pending' | 'destructive' | 'secondary'> = {
  ok: 'ready',
  warning: 'pending',
  error: 'destructive',
  idle: 'secondary',
};

export function RecordingHealth({ view }: RecordingHealthProps) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {view.startingMessage && (
          <p className="text-sm font-medium text-foreground">{view.startingMessage}</p>
        )}

        {view.finishingMessage && (
          <p className="text-sm font-medium text-foreground">{view.finishingMessage}</p>
        )}

        {view.state === 'recording' && (
          <div className="space-y-2" role="status" aria-label={view.ariaSummary}>
            {view.channels.map((channel) => (
              <div
                key={channel.label}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm font-medium text-foreground">{channel.label}</span>
                <div className="flex items-center gap-2">
                  <Badge variant={toneVariant[channel.tone]}>{channel.statusText}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Screen-reader summary for status transitions */}
        <span className="sr-only" aria-live="polite">{view.ariaSummary}</span>
      </CardContent>
    </Card>
  );
}
