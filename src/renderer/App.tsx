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
      await audioCapture.start();
      setStatus('capturing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  const stopCapture = () => {
    audioCapture.stop();
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
