import { useEffect, useState } from 'preact/hooks';
import { api, type ModelInfo } from '../lib';

export function NewRunPanel() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string>('');
  const [maxTurns, setMaxTurns] = useState('50');
  const [temperature, setTemperature] = useState('0.3');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ models: ModelInfo[] }>('/api/v1/models').then((data) => setModels(data.models));
  }, []);

  function toggleModel(id: string) {
    setSelectedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      let sourcePath = uploadedPath;
      if (file && !sourcePath) {
        const form = new FormData();
        form.append('file', file);
        const uploadRes = await fetch('/api/v1/upload', { method: 'POST', body: form });
        if (!uploadRes.ok) throw new Error('Upload failed');
        const uploadData = await uploadRes.json() as { path: string };
        sourcePath = uploadData.path;
      }

      if (!sourcePath) {
        setError('Upload a source file first');
        setSubmitting(false);
        return;
      }

      const res = await api<{ runIds: string[] }>('/api/v1/runs', {
        method: 'POST',
        body: JSON.stringify({
          models: selectedModels,
          sourceFilePath: sourcePath,
          maxTurns: Number(maxTurns),
          temperature: Number(temperature),
        }),
      });

      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start run');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 class="text-xl font-semibold mb-6">New Experiment Run</h1>

      <form onSubmit={handleSubmit} class="space-y-6 max-w-2xl">
        {error && (
          <div class="p-3 rounded-md bg-red-900/20 border border-red-800 text-red-300 text-sm">{error}</div>
        )}

        <div>
          <label class="block text-sm font-medium mb-2">Source File</label>
          <input
            type="file"
            accept=".md,.txt,.pdf"
            onChange={(e) => {
              const target = e.target as HTMLInputElement;
              setFile(target.files?.[0] ?? null);
              setUploadedPath('');
            }}
            class="block w-full text-sm text-[color:var(--color-fg-muted)] file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:bg-[color:var(--color-bg-hover)] file:text-[color:var(--color-fg)] hover:file:bg-[color:var(--color-border-strong)] file:cursor-pointer file:transition"
          />
          <p class="text-xs text-[color:var(--color-fg-subtle)] mt-1">Upload a .md or .txt file to use as ingest source</p>
        </div>

        <div>
          <label class="block text-sm font-medium mb-3">Models to Test</label>
          <div class="space-y-2">
            {models.map((m) => (
              <label class="flex items-center gap-3 p-3 rounded-md border border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)] cursor-pointer transition" style={selectedModels.includes(m.id) ? 'border-color: var(--color-accent); background: rgba(59,130,246,0.05)' : ''}>
                <input
                  type="checkbox"
                  checked={selectedModels.includes(m.id)}
                  onChange={() => toggleModel(m.id)}
                  class="w-4 h-4 accent-[color:var(--color-accent)]"
                />
                <div class="flex-1">
                  <span class="font-medium">{m.label}</span>
                  <span class="text-[color:var(--color-fg-subtle)] text-xs ml-2 font-mono">{m.id}</span>
                </div>
                <span class="text-xs text-[color:var(--color-fg-muted)] font-mono">
                  ${m.input}/M in · ${m.output}/M out
                </span>
              </label>
            ))}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium mb-2">Max Turns</label>
            <input
              type="number"
              value={maxTurns}
              onInput={(e) => setMaxTurns((e.target as HTMLInputElement).value)}
              class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] text-[color:var(--color-fg)] text-sm"
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">Temperature</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="1"
              value={temperature}
              onInput={(e) => setTemperature((e.target as HTMLInputElement).value)}
              class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] text-[color:var(--color-fg)] text-sm"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting || selectedModels.length === 0 || !file}
          class="px-6 py-2.5 bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] rounded-md text-sm font-medium hover:opacity-90 active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Starting...' : `Run ${selectedModels.length} Model${selectedModels.length !== 1 ? 's' : ''}`}
        </button>
      </form>
    </div>
  );
}
