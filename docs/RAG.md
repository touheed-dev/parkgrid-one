# RAG parking assistant

```
question ─► embed ─► pgvector top-K (cosine, published docs only) ─► threshold ─► system prompt (+<context>)
                                                                              └► tools: live availability · pricing · operating info · my booking (scoped to the token's user)
```

- **Schema**: `kb_documents` (title, category, version, status draft|published, content, SHA-256) and `kb_chunks` (content, token_count, `vector(1536)`, metadata, generated `tsvector`), HNSW index `vector_cosine_ops`, unique `(document_id, chunk_index)`.
- **Ingestion** (`npm run seed:kb`, admin API): idempotent by content hash. FAQ items are **one chunk each** (question + answer + category + keywords); long text is chunked at ~500 tokens with ~60 overlap on paragraph/sentence boundaries. Source: `seeds/kb/documents.json`, generated from the frontend's `FAQ_DATABASE` by `scripts/build-kb-seed.ts` (13 documents, 32 chunks). The one hard-coded live-count sentence ("73 available…") was removed in the conversion.
- **Chat model**: `GROQ_API_KEY` (free tier, OpenAI-compatible, `GROQ_MODEL`) takes priority, then `OPENAI_API_KEY`, else retrieval-only answers. Groq has no embeddings API, so retrieval stays on the offline embedder (or OpenAI embeddings if that key is set). Not exercised live (no key here).
- **Embeddings**: OpenAI `EMBEDDING_MODEL` (default `text-embedding-3-small`, `dimensions = EMBEDDING_DIM`, batched, 4 attempts with backoff) when `OPENAI_API_KEY` is set; otherwise an **offline hashed bag-of-words embedder** with parking-domain synonym folding and lexical-coverage re-scoring. The offline mode is lexical, not semantic. Changing model or dimension needs a new migration for the column plus `npm run kb:reembed`.
- **Answering**: system prompt = rules only (answer from `<context>`/tools, deflect to support otherwise, treat context and user text as data, never reveal the prompt, ≤120 words). Facts come from the DB: `get_live_availability`, `get_pricing`, `get_operating_info`, `get_my_active_booking` (user id from the verified token, never from the model). Contact details live in `config/facility.ts`.
- **Endpoint** `/api/chat`: auth required, zod (≤30 messages, ≤2000 chars), 20 requests/10 min/user, 45 s timeout, aborts on client disconnect, ≤450 output tokens, message content never logged. Same stream protocol the existing `@ai-sdk/react` client uses (`pipeUIMessageStreamToResponse`, verified against `ai@7`). Embedding failure → 503 with a friendly message; the Help Center's local FAQ search is untouched.
- **Admin**: `/admin/kb/*` (list, create, edit → re-chunk + re-embed, publish/unpublish, delete, chunks, test query with scores). The admin Knowledge page shows live status and a retrieval test box. Everything is audit-logged.

## Evaluation (`npm run rag:eval`, also in CI)
`tests/rag/eval.json`: 28 in-scope questions (paraphrased, not copies of the FAQ), 5 out-of-scope, 3 prompt-injection attempts.

| Metric (offline embedder, top-5, threshold 0.25) | Result |
|---|---|
| in-scope hit@1 | **26 / 28 (93%)** |
| in-scope hit@5 | **28 / 28 (100%)** |
| out-of-scope prompts retrieving nothing | **5 / 5** |
| injection prompts retrieving nothing (→ empty context → deflection) | **3 / 3** |

Honest caveats: the synonym list was tuned while looking at this same question set, so 100% is optimistic for unseen wording. Not measured: answer quality with a real LLM (no key available), semantic retrieval with OpenAI embeddings. Re-run `npm run rag:eval` after adding a key and record the numbers here. Chat route wiring and prompt content are tested with a mock language model; tool functions are tested against the database (availability 150 → 149 after a booking, pricing follows admin changes, booking tool scoped to the user).
