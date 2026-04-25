/**
 * F47 — OpenAI Whisper transcription service.
 *
 * Pricing (April 2026): whisper-1 = $0.006/minute = $0.0001/second
 *                                 = 0.01 USD-cent/second
 * Source: https://openai.com/api/pricing
 *
 * 25MB upload cap per Whisper-API request — files larger than that
 * fail with HTTP 400. Future chunked-upload feature splits long audio
 * (F47b) but is not part of v1.
 *
 * Per-tenant API key: F149's tenant_secrets.openai_api_key takes
 * precedence over process.env.OPENAI_API_KEY when set. The orchestrator
 * is responsible for resolving the right key — this module receives
 * whatever the caller passes via env.
 */

const OPENAI_AUDIO_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'whisper-1';
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS ?? 180_000);

// 0.6 cents per minute = 0.01 cent per second
const WHISPER_CENT_PER_SECOND = 0.01;

export interface TranscriptionResult {
  text: string;
  language: string;
  durationSeconds: number;
  costCents: number;
  model: string;
}

export async function transcribeAudio(
  bytes: Buffer,
  filename: string,
  contentType?: string,
): Promise<TranscriptionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const blob = new Blob([bytes], { type: contentType ?? 'audio/wav' });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', WHISPER_MODEL);
  // verbose_json gives us duration + language alongside the text.
  form.append('response_format', 'verbose_json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const res = await fetch(OPENAI_AUDIO_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`whisper API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      text: string;
      language?: string;
      duration?: number;
    };

    const durationSeconds = Number(data.duration ?? 0);
    return {
      text: data.text,
      language: data.language ?? 'unknown',
      durationSeconds,
      // Round up so a 0.5-sec ping isn't free; matches F25's vision-cost rounding.
      costCents: Math.max(1, Math.ceil(durationSeconds * WHISPER_CENT_PER_SECOND)),
      model: WHISPER_MODEL,
    };
  } finally {
    clearTimeout(timer);
  }
}
