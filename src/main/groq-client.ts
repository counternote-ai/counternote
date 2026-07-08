import * as fs from 'fs';
import * as path from 'path';

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

export interface TranscriptionResult {
  segments: TranscriptionSegment[];
}

export class GroqClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'whisper-large-v3-turbo') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async transcribe(audioPath: string, speaker: string): Promise<TranscriptionSegment[]> {
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
    const fileName = path.basename(audioPath);

    const formData = new FormData();
    formData.append('file', audioBlob, fileName);
    formData.append('model', this.model);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return data.segments.map((seg: any) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      speaker,
    }));
  }
}
