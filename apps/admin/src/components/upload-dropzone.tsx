import { useCallback, useRef, useState } from 'preact/hooks';
import { uploadSource, ApiError } from '../api';
import type { Document } from '@trail/shared';

/**
 * Drag-and-drop upload zone for source documents. Accepts the extensions
 * the engine whitelists today (.md, .pdf, .docx, .pptx, .doc, .ppt, images,
 * html, csv, txt, xlsx/xls). We don't restrict client-side beyond the obvious
 * — the engine is authoritative, and a clear error beats a silent drop.
 *
 * Uploads run sequentially so upload progress + errors are readable. Parallel
 * uploads would saturate the Sanne-sized docx ingest path (LLM compile is the
 * real bottleneck) without a user-visible benefit.
 */
export function UploadDropzone({
  kbId,
  onUploaded,
}: {
  kbId: string;
  onUploaded: (doc: Document) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<Array<{ name: string; state: 'pending' | 'uploading' | 'done' | 'error'; message?: string }>>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pickFiles = useCallback(() => inputRef.current?.click(), []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setQueue((prev) => [
        ...prev,
        ...files.map((f) => ({ name: f.name, state: 'pending' as const })),
      ]);

      for (const file of files) {
        setQueue((prev) =>
          prev.map((q) => (q.name === file.name && q.state === 'pending' ? { ...q, state: 'uploading' } : q)),
        );
        try {
          const doc = await uploadSource(kbId, file);
          setQueue((prev) =>
            prev.map((q) => (q.name === file.name ? { ...q, state: 'done' } : q)),
          );
          onUploaded(doc);
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : String(err);
          setQueue((prev) =>
            prev.map((q) => (q.name === file.name ? { ...q, state: 'error', message: msg } : q)),
          );
        }
      }

      // Clear 'done' rows after 3s so the queue doesn't balloon across many uploads.
      setTimeout(() => {
        setQueue((prev) => prev.filter((q) => q.state !== 'done'));
      }, 3000);
    },
    [kbId, onUploaded],
  );

  return (
    <div>
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          // Only clear when leaving the element itself, not children.
          if (e.currentTarget === e.target) setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
          handleFiles(files);
        }}
        onClick={pickFiles}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickFiles();
          }
        }}
        class={
          'cursor-pointer rounded-md border-2 border-dashed px-6 py-8 text-center transition ' +
          (dragActive
            ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5'
            : 'border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-card)]/40')
        }
      >
        <div class="font-medium text-sm">Drop files here or click to browse</div>
        <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] mt-1">
          .md · .pdf · .docx · .pptx · .txt · .html · .csv · images
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          class="hidden"
          onChange={(e) => {
            const files = Array.from((e.currentTarget as HTMLInputElement).files ?? []);
            handleFiles(files);
            (e.currentTarget as HTMLInputElement).value = '';
          }}
        />
      </div>

      {queue.length ? (
        <ul class="mt-3 space-y-1 text-[11px] font-mono">
          {queue.map((q) => (
            <li key={q.name} class="flex items-center justify-between gap-3">
              <span class="truncate text-[color:var(--color-fg-muted)]">{q.name}</span>
              <span
                class={
                  q.state === 'done'
                    ? 'text-[color:var(--color-success)]'
                    : q.state === 'error'
                    ? 'text-[color:var(--color-danger)]'
                    : 'text-[color:var(--color-fg-subtle)]'
                }
              >
                {q.state === 'pending' && '…queued'}
                {q.state === 'uploading' && 'uploading…'}
                {q.state === 'done' && '✓ done'}
                {q.state === 'error' && `✗ ${q.message ?? 'failed'}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
