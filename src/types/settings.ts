export type TranscriptExportIpcResult =
  { success: true } | { success: false; code: 'TRANSCRIPT_EXPORT_FAILED' };

export type ShowInFinderIpcResult =
  { success: true } | { success: false; code: 'SHOW_IN_FINDER_FAILED' };
