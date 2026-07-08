import * as fs from 'fs';
import * as path from 'path';
import { GroqClient, TranscriptionSegment } from './groq-client';
import { splitChannels, convertToFlac, getAudioDuration } from './audio-processor';
import { getGroqApiKey, loadConfig } from './config';

export interface Transcript {
  id: string;
  title: string;
  duration: number;
  audioFile: string;
  createdAt: string;
  transcribedAt: string;
  segments: TranscriptionSegment[];
}

export async function transcribeRecording(audioPath: string): Promise<Transcript> {
  const apiKey = await getGroqApiKey();
  if (!apiKey) {
    throw new Error('Groq API key not configured');
  }

  const config = loadConfig();
  const client = new GroqClient(apiKey, config.groqModel);

  // Split channels
  const { system, mic } = await splitChannels(audioPath);

  // Convert to FLAC for upload
  const systemFlac = await convertToFlac(system);
  const micFlac = await convertToFlac(mic);

  // Transcribe both channels
  const [systemSegments, micSegments] = await Promise.all([
    client.transcribe(systemFlac, 'Interviewer'),
    client.transcribe(micFlac, 'You'),
  ]);

  // Merge and sort by timestamp
  const allSegments = [...systemSegments, ...micSegments].sort((a, b) => a.start - b.start);

  // Get duration
  const duration = await getAudioDuration(audioPath);

  // Create transcript
  const id = path.basename(path.dirname(audioPath));
  const transcript: Transcript = {
    id,
    title: `Interview — ${new Date(id).toLocaleDateString()}`,
    duration,
    audioFile: 'audio.wav',
    createdAt: new Date().toISOString(),
    transcribedAt: new Date().toISOString(),
    segments: allSegments,
  };

  // Save transcript
  const transcriptPath = path.join(path.dirname(audioPath), 'transcript.json');
  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));

  // Clean up temporary files
  fs.unlinkSync(system);
  fs.unlinkSync(mic);
  fs.unlinkSync(systemFlac);
  fs.unlinkSync(micFlac);

  return transcript;
}
