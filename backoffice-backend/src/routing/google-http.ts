const minuteMs = 60_000;

export class GoogleRequestBudget {
  private recentRequests: number[] = [];
  private inFlight = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly simultaneousRequests: number,
    private readonly now: () => number,
  ) {}

  start(): (() => void) | null {
    const now = this.now();
    this.recentRequests = this.recentRequests.filter((started) => now - started < minuteMs);
    if (this.inFlight >= this.simultaneousRequests || this.recentRequests.length >= this.requestsPerMinute) return null;
    this.recentRequests.push(now);
    this.inFlight++;
    return () => { this.inFlight--; };
  }
}

export async function readBoundedGoogleJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Google API response body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('Google API response exceeded the size limit');
      json += decoder.decode(chunk.value, { stream: true });
    }
    const payload: unknown = JSON.parse(json + decoder.decode());
    return payload;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
