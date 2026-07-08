import React, { useState } from 'react';
import { AudioCapture } from './audio-capture';

const audioCapture = new AudioCapture();

export default function App() {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);

  const startCapture = async () => {
    try {
      setError(null);
      setStatus('requesting');

      // Start recording on main process
      const result = await window.electronAPI.startRecording();
      if (!result.success) {
        throw new Error('Failed to start recording');
      }

      // Start audio capture
      await audioCapture.start();
      setStatus('capturing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  const stopCapture = async () => {
    audioCapture.stop();
    await window.electronAPI.stopRecording();
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
