import React from 'react';
import { ChevronLeft, Download, FileText } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { formatDuration, getTranscriptMeta } from '../recording-utils';

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface TranscriptViewProps {
  title: string;
  duration?: number;
  segments: Segment[];
  onBack: () => void;
  onExport: () => void;
}

export function TranscriptView({ title, duration = 0, segments, onBack, onExport }: TranscriptViewProps) {
  const meta = getTranscriptMeta({ duration, segmentCount: segments.length });

  return (
    <main className="app-shell">
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" size="pill" onClick={onBack}>
            <ChevronLeft />
            Back
          </Button>
          <Button variant="outline" size="pill" onClick={onExport} disabled={segments.length === 0}>
            <Download />
            Export
          </Button>
        </div>

        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <FileText className="h-4 w-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <h1 className="truncate text-lg font-semibold text-foreground">{title}</h1>
                <p className="text-xs text-muted-foreground">{meta}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </header>

      {segments.length === 0 ? (
        <Card className="flex flex-1 items-center justify-center border-dashed bg-card/80">
          <CardContent className="max-w-64 space-y-2 p-6 text-center">
            <h2 className="text-base font-semibold">No transcript segments</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Transcribed interview text will appear here once this recording has segments.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="app-scroll-shadow min-h-0 flex-1 pr-1">
          <Card>
            <CardContent className="p-4">
              {segments.map((seg, i) => {
                const isInterviewer = seg.speaker === 'Interviewer';

                return (
                  <div
                    key={`${seg.start}-${i}`}
                    className={i === 0 ? undefined : 'mt-4 border-t border-border pt-4'}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant={isInterviewer ? 'interviewer' : 'you'}>{seg.speaker}</Badge>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(seg.start)}</span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-foreground">{seg.text}</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </ScrollArea>
      )}
    </main>
  );
}
