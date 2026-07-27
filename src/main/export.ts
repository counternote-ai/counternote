import * as fs from 'fs';
import * as path from 'path';
import { Transcript } from '../types/transcript';

export function exportToPlainText(transcript: Transcript): string {
  const lines: string[] = [];

  lines.push(transcript.title);
  lines.push(`Duration: ${Math.floor(transcript.duration / 60)}:${(transcript.duration % 60).toString().padStart(2, '0')}`);
  lines.push('');

  for (const segment of transcript.segments) {
    const timestamp = `${Math.floor(segment.start / 60)}:${Math.floor(segment.start % 60).toString().padStart(2, '0')}`;
    lines.push(`[${timestamp}] ${segment.speaker}:`);
    lines.push(segment.text);
    lines.push('');
  }

  return lines.join('\n');
}

export function saveExport(transcript: Transcript, format: 'txt', transcriptPath: string): string {
  const content = exportToPlainText(transcript);
  const exportPath = path.join(
    path.dirname(transcriptPath),
    `transcript.${format}`
  );
  fs.writeFileSync(exportPath, content);
  return exportPath;
}
