import { http } from "./http";

export interface KbDocument {
  id: string;
  title: string;
  category: string;
  source: string | null;
  version: number;
  language: string;
  status: "draft" | "published";
  chunk_count: number;
  size_chars: number;
  updated_at: string;
}

export interface KbStatus {
  documents: number;
  published_documents: number;
  chunks: number;
  embedded_chunks: number;
  vectorDimension: number;
  embeddingProvider: "openai" | "local";
  embeddingModel: string;
  status: "OPERATIONAL" | "NEEDS_ATTENTION";
}

export interface KbSearchResult {
  chunk_id: string;
  document_id: string;
  title: string;
  category: string;
  content: string;
  score: number;
  accepted: boolean;
}

export const kbStatus = () => http.get<{ status: KbStatus }>("/admin/kb/status");
export const kbListDocuments = () => http.get<{ documents: KbDocument[] }>("/admin/kb/documents");
export const kbSearch = ({ data }: { data: { query: string; topK?: number } }) =>
  http.post<{ minScore: number; results: KbSearchResult[] }>("/admin/kb/search", data);
export const kbSetStatus = ({ data }: { data: { id: string; status: "draft" | "published" } }) =>
  http.patch<{ id: string }>(`/admin/kb/documents/${data.id}`, { status: data.status });
export const kbReembed = ({ data }: { data: { id: string } }) =>
  http.post<{ chunks: number }>(`/admin/kb/documents/${data.id}/reembed`);
