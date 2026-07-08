import React, { useState, useRef } from 'react';

export default function App() {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCapture = async () => {
    try {
      setError(null);
      setStatus('requesting');

      // Request display media with audio
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      // Stop video track immediately (keep only audio)
      displayStream.getVideoTracks().forEach((track) => track.stop());

      // Get microphone
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      streamRef.current = new MediaStream([
        ...displayStream.getAudioTracks(),
        ...micStream.getAudioTracks(),
      ]);

      setStatus('capturing');
      console.log('Audio tracks:', streamRef.current.getAudioTracks().length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  const stopCapture = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus('idle');
  };

  return (
    <div>
      <h1>Interview Copilot</h1>
      <p>Status: {status}</p>
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {status === 'idle' || status === 'error' ? (
        <button onClick={startCapture}>Start Capture Test</button>
      ) : (
        <button onClick={stopCapture}>Stop Capture</button>
      )}
    </div>
  );
}
