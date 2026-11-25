-- Up Migration
-- RAG knowledge base: documents + embedded chunks (pgvector, HNSW cosine).
-- The vector dimension (1536 = OpenAI text-embedding-3-small) must match EMBEDDING_DIM.
-- Changing embedding model/dimension requires a new migration + `npm run kb:reembed`.

create table kb_documents (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  category      text not null default 'general',
  source        text,
  version       int not null default 1,
  language      text not null default 'en',
  status        text not null default 'draft' check (status in ('draft', 'published')),
  content       text not null,
  content_hash  text not null,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index idx_kb_documents_hash on kb_documents (content_hash);
create index idx_kb_documents_status on kb_documents (status);

create trigger kb_documents_set_updated_at
  before update on kb_documents
  for each row execute function set_updated_at();

create table kb_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references kb_documents (id) on delete cascade,
  chunk_index  int not null,
  content      text not null,
  token_count  int not null default 0,
  embedding    vector(1536),
  metadata     jsonb not null default '{}'::jsonb,
  tsv          tsvector generated always as (to_tsvector('english', content)) stored,
  created_at   timestamptz not null default now(),
  constraint kb_chunks_doc_idx_key unique (document_id, chunk_index)
);

create index idx_kb_chunks_embedding on kb_chunks using hnsw (embedding vector_cosine_ops);
create index idx_kb_chunks_tsv on kb_chunks using gin (tsv);

-- Down Migration
drop table if exists kb_chunks;
drop table if exists kb_documents;
