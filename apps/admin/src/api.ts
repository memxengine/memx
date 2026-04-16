import type {
  QueueCandidate,
  QueueCandidateKind,
  QueueCandidateStatus,
  ApproveCandidatePayload,
  RejectCandidatePayload,
  KnowledgeBase,
} from '@trail/shared';

/**
 * Typed fetch wrapper.
 * Cookies flow via credentials: 'include'. Errors surface as thrown
 * `ApiError` with status + server-provided message.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body.error) {
        message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
      }
    } catch {
      // ignore
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Resources ────────────────────────────────────────────────────

export function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return api('/api/v1/knowledge-bases');
}

export interface QueueListResponse {
  items: QueueCandidate[];
  count: number;
}

export interface QueueFilter {
  knowledgeBaseId?: string;
  kind?: QueueCandidateKind;
  status?: QueueCandidateStatus;
  limit?: number;
}

export function listQueue(filter: QueueFilter = {}): Promise<QueueListResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return api(`/api/v1/queue?${qs.toString()}`);
}

export function getCandidate(id: string): Promise<QueueCandidate> {
  return api(`/api/v1/queue/${encodeURIComponent(id)}`);
}

export interface ApprovalResponse {
  candidateId: string;
  documentId: string;
  wikiEventId: string;
  autoApproved: boolean;
}

export function approveCandidate(
  id: string,
  payload: ApproveCandidatePayload = { path: '/wiki/queries/' },
): Promise<ApprovalResponse> {
  return api(`/api/v1/queue/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function rejectCandidate(
  id: string,
  payload: RejectCandidatePayload = {},
): Promise<{ candidateId: string; reason: string | null }> {
  return api(`/api/v1/queue/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
