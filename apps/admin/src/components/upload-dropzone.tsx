import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { uploadSource, ApiError } from '../api';
import type { Document } from '@trail/shared';

/**
 * Window-wide drag-and-drop zone for uploading source documents.
 *
 * Small dropzones are error-prone — if the user drops a pixel outside the
 * zone's rect the browser falls back to opening/downloading the file. So we
 * attach drag listeners to the whole window while this component is mounted
 * and show a full-screen overlay while a file is being dragged in. The inline
 * card is a discoverability hint + click-to-browse fallback.
 *
 * Uploads run sequentially so per-file status is readable and we don't
 * saturate the LLM compile pipeline with parallel jobs.
 */
export function UploadDropzone({
  kbId,
  onUploaded,
}: {
  kbId: string;
  onUploaded: (doc: Document) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<
    Array<{ id: string; name: string; state: 'pending' | 'uploading' | 'done' | 'error'; message?: string }>
  >([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Nested dragenter/dragleave fire on every child crossing — a counter is
  // simpler and more reliable than rect-math or relatedTarget checks.
  const dragDepth = useRef(0);

  const pickFiles = useCallback(() => inputRef.current?.click(), []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const entries = files.map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
      }));

      setQueue((prev) => [
        ...prev,
        ...entries.map((e) => ({ id: e.id, name: e.file.name, state: 'pending' as const })),
      ]);

      for (const { id, file } of entries) {
        setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, state: 'uploading' } : q)));
        try {
          const doc = await uploadSource(kbId, file);
          setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, state: 'done' } : q)));
          onUploaded(doc);
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : String(err);
          setQueue((prev) =>
            prev.map((q) => (q.id === id ? { ...q, state: 'error', message: msg } : q)),
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

  // Window-level drag listeners. Every handler preventDefaults so the browser
  // never falls back to its "open/download the file" behaviour, regardless of
  // where in the viewport the user drops.
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onWindowDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    };
    const onWindowDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onWindowDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    };
    const onWindowDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (files.length) handleFiles(files);
    };

    window.addEventListener('dragenter', onWindowDragEnter);
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('drop', onWindowDrop);
    return () => {
      window.removeEventListener('dragenter', onWindowDragEnter);
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('drop', onWindowDrop);
    };
  }, [handleFiles]);

  return (
    <>
      <div
        onClick={pickFiles}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickFiles();
          }
        }}
        class="cursor-pointer rounded-md border-2 border-dashed border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-card)]/40 px-6 py-8 text-center transition"
      >
        <div class="font-medium text-sm">Drop files anywhere, or click to browse</div>
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
            <li key={q.id} class="flex items-center justify-between gap-3">
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

      {dragActive ? (
        <div class="fixed inset-0 z-50 bg-[color:var(--color-bg)]/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div class="flex flex-col items-center gap-3 border-2 border-dashed border-[color:var(--color-accent)] rounded-xl px-12 py-10 bg-[color:var(--color-bg-card)]">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-[color:var(--color-accent)]">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            <div class="text-sm font-medium">Drop files to upload</div>
            <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
              The whole window is a drop target
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
