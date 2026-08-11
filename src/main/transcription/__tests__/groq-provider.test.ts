jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue(Buffer.from('fake audio')),
}));

import { GroqProvider, GroqProviderRequest, GroqProviderDependencies } from '../groq-provider';

const baseRequest: GroqProviderRequest = {
  audioPath: '/recordings/interviewer.flac',
  speaker: 'Interviewer',
  apiKey: 'sk-test-key',
  model: 'whisper-large-v3-turbo',
};

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status, headers });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function validResponse(): Response {
  return jsonResponse({
    segments: [{ start: 0, end: 2.5, text: 'Hello world' }],
  });
}

function createProvider(overrides: Partial<GroqProviderDependencies> = {}): GroqProvider {
  return new GroqProvider({
    fetch: overrides.fetch ?? jest.fn(),
    setTimeout: overrides.setTimeout ?? setTimeout,
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
    now: overrides.now ?? Date.now,
  });
}

describe('GroqProvider', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('transcribes a valid Groq verbose_json response', async () => {
    fetchMock.mockResolvedValue(validResponse());
    const provider = createProvider({ fetch: fetchMock });

    await expect(provider.transcribe(baseRequest)).resolves.toEqual([
      { start: 0, end: 2.5, text: 'Hello world', speaker: 'Interviewer' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const formData = init.body as FormData;
    const audioFile = formData.get('file') as File;
    expect(audioFile.name).toBe('interviewer.flac');
    expect(audioFile.type).toBe('audio/flac');
  });

  it('retries one 429 after a short retry-after delay', async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(validResponse());

    const provider = createProvider({ fetch: fetchMock });
    const pending = provider.transcribe(baseRequest);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the safe retry time without waiting longer than 60 seconds', async () => {
    fetchMock.mockResolvedValue(response(429, { 'retry-after': '1080' }));

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_RATE_LIMITED',
      retryAfterSeconds: 1080,
    });
  });

  it('throws GROQ_RATE_LIMITED when retry-after is missing', async () => {
    fetchMock.mockResolvedValue(response(429));

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_RATE_LIMITED',
    });
  });

  it('throws GROQ_RATE_LIMITED when retry-after is unparseable', async () => {
    fetchMock.mockResolvedValue(response(429, { 'retry-after': 'soon' }));

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_RATE_LIMITED',
    });
  });

  it('does not retry a second 429', async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(429, { 'retry-after': '2' }));

    const provider = createProvider({ fetch: fetchMock });
    const pending = provider.transcribe(baseRequest);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'GROQ_RATE_LIMITED',
    });
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 with a short HTTP-date retry-after', async () => {
    const now = new Date('2024-01-01T00:00:00Z').getTime();
    const provider = createProvider({ fetch: fetchMock, now: () => now });
    const future = new Date(now + 2_000).toUTCString();

    fetchMock
      .mockResolvedValueOnce(response(429, { 'retry-after': future }))
      .mockResolvedValueOnce(validResponse());

    const pending = provider.transcribe(baseRequest);
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns retryAfterSeconds for a distant HTTP-date retry-after', async () => {
    const now = new Date('2024-01-01T00:00:00Z').getTime();
    const provider = createProvider({ fetch: fetchMock, now: () => now });
    const future = new Date(now + 1_080_000).toUTCString();

    fetchMock.mockResolvedValue(response(429, { 'retry-after': future }));

    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_RATE_LIMITED',
      retryAfterSeconds: 1080,
    });
  });

  it('throws GROQ_TIMEOUT when the request exceeds ten minutes', async () => {
    fetchMock.mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    });

    const provider = createProvider({ fetch: fetchMock });
    const pending = provider.transcribe(baseRequest);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'GROQ_TIMEOUT',
    });
    await jest.advanceTimersByTimeAsync(600_000);
    await assertion;
  });

  it('throws GROQ_REJECTED for non-429 error statuses', async () => {
    fetchMock.mockResolvedValue(response(500));

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when segments are missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'hello' }));

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when a segment timestamp is not a number', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ segments: [{ start: null, end: 2, text: 'hello' }] })
    );

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when a segment timestamp is not finite', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ segments: [{ start: NaN, end: 2, text: 'hello' }] })
    );

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when a segment has negative timestamps', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ segments: [{ start: -1, end: 2, text: 'hello' }] })
    );

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when end is before start', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ segments: [{ start: 3, end: 2, text: 'hello' }] })
    );

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('throws GROQ_REJECTED when segment text is not a string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ segments: [{ start: 0, end: 2, text: 123 }] })
    );

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).rejects.toMatchObject({
      code: 'GROQ_REJECTED',
    });
  });

  it('omits all-whitespace segments', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segments: [
          { start: 0, end: 1, text: '   ' },
          { start: 1, end: 2, text: 'hello' },
        ],
      })
    );

    const provider = createProvider({ fetch: fetchMock });
    await expect(provider.transcribe(baseRequest)).resolves.toEqual([
      { start: 1, end: 2, text: 'hello', speaker: 'Interviewer' },
    ]);
  });

  it('throws GROQ_KEY_MISSING when apiKey is absent', async () => {
    const provider = createProvider({ fetch: fetchMock });
    await expect(
      provider.transcribe({ ...baseRequest, apiKey: undefined })
    ).rejects.toMatchObject({ code: 'GROQ_KEY_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws GROQ_KEY_MISSING when apiKey is empty', async () => {
    const provider = createProvider({ fetch: fetchMock });
    await expect(
      provider.transcribe({ ...baseRequest, apiKey: '' })
    ).rejects.toMatchObject({ code: 'GROQ_KEY_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
