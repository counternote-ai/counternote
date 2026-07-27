export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

export interface Transcript {
  id: string;
  title: string;
  duration: number;
  audioFile: string;
  createdAt: string;
  transcribedAt: string;
  segments: TranscriptionSegment[];
}
