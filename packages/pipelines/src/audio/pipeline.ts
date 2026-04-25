import type { Pipeline, PipelineInput, PipelineResult } from '../interface.js';

/**
 * F47 — audio source pipeline (OpenAI Whisper).
 *
 * Sends `.wav` / `.mp3` / `.m4a` / `.ogg` / `.flac` / `.aac` to the
 * `transcribeAudio` callback (orchestrator wires it to OpenAI's
 * Whisper API). Wraps the returned text in a markdown shell with
 * filename + duration + language metadata, then forwards
 * Whisper-cost as `extractCostCents` for F156 credits-deduction.
 *
 * Diarization (who-said-what), real-time, audio-cleanup, segment-
 * timestamps and chunked upload for >25MB files are all explicit
 * non-goals for v1 — see plan-doc.
 */
export const audioPipeline: Pipeline = {
  name: 'audio',
  accepts: (filename, mime) => {
    if (mime?.startsWith('audio/')) return 1;
    if (/\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(filename)) return 0.95;
    return 0;
  },
  handle: async (input: PipelineInput): Promise<PipelineResult> => {
    if (!input.transcribeAudio) {
      throw new Error(
        '[audio-pipeline] requires transcribeAudio callback ' +
          '(orchestrator must wire OpenAI Whisper; check OPENAI_API_KEY)',
      );
    }
    const result = await input.transcribeAudio(input.buffer, input.filename, input.mime);
    if (!result) {
      throw new Error(
        '[audio-pipeline] transcription returned null — likely missing OPENAI_API_KEY',
      );
    }

    const stem = input.filename.replace(/\.[a-z0-9]+$/i, '');
    const minutes = Math.round((result.durationSeconds / 60) * 10) / 10;
    const minutesLabel = minutes === 1 ? 'minut' : 'minutter';
    const markdown = `# ${stem}

**Type:** Lyd-optagelse (transskription)
**Varighed:** ${minutes} ${minutesLabel}
**Sprog:** ${result.language}
**Model:** ${result.model}

---

${result.text}
`;

    return {
      markdown,
      title: stem,
      warnings: [],
      extractCostCents: result.costCents,
      extractModel: result.model,
    };
  },
};
