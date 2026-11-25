# Runbook

## Local setup (10 commands)
```powershell
cd backend
Copy-Item .env.example .env            # then set JWT_ACCESS_SECRET (>= 32 chars)
docker compose up -d postgres mailpit   # Postgres 16 + pgvector on :54329, Mailpit UI on :8025
npm ci
npm run migrate
npm run seed                            # 5 levels, 150 slots, settings, knowledge base
$env:ADMIN_SEED_EMAIL="you@example.com"; $env:ADMIN_SEED_PASSWORD="a-long-password-12+"; npm run seed:admin
npm run dev                             # API on :4000
cd ../frontend; npm ci; npm run dev     # web app on :8080 (set VITE_API_URL if the API is elsewhere)
```
Staff accounts: sign up normally, then an admin sets the role at **Admin → Users**. Password-reset emails appear in Mailpit (`http://localhost:8025`).

## Checks
`npm run ci` in `backend/` = typecheck + lint + 101 tests (real Postgres, includes migration up/down and the 25-parallel double-booking test) + build. `npm run rag:eval` for retrieval quality. `frontend/`: `npm run typecheck && npm run lint && npm run build`.

## Environment
See `backend/.env.example` (validated by zod at boot; the server refuses to start when something required is missing or weak). Frontend: only `VITE_API_URL`.

## Deploy (suggested)
- **DB**: Neon (or any Postgres with `vector`). Use the connection string only (`DATABASE_SSL=true`). No Supabase Auth/Realtime/RLS involved.
- **API**: Render/Railway/Fly using `backend/Dockerfile` (multi-stage, non-root, `/healthz` health check). Release step: `npm run migrate`. Set `TRUST_PROXY=1`, `CORS_ORIGINS=<web origin>`, `NODE_ENV=production`, secrets from the host's secret store. Create the first admin by running `npm run seed:admin` from your machine against the production `DATABASE_URL`.
- **Web**: Cloudflare (Nitro build output) or any host; build with `VITE_API_URL=<api url>`.
- **CI/CD**: `.github/workflows/ci.yml` (backend with a pgvector service container, frontend, image build, audit, bundle-secret check) and `deploy.yml` (runs after CI on `main`; each step skips itself until its secret exists: `RENDER_DEPLOY_HOOK_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, repository variable `API_URL`).
- Jobs run in-process (`ENABLE_JOBS=true`) under advisory locks. To use an external scheduler instead set `ENABLE_JOBS=false` and call `POST /internal/jobs/<name>` with `x-cron-secret`.

## Operating
- Stuck refund: it stays `pending`; the 5-minute job retries; or `POST /internal/jobs/settlePendingRefunds`.
- Webhook failures: `select event_id, event_type, error from webhook_events where processed_at is null;` (Razorpay also retries).
- Everything an admin did: Admin → Settings → audit log, or `admin_audit_log`.

## Known limitations and next steps
- Real Razorpay and real OpenAI were **not** exercised (no keys): covered by signed fake webhooks, a fake gateway and a mock language model. First task after adding keys: one test-mode payment end to end, then `npm run rag:eval`.
- Overstay with Razorpay is recorded as `due` (collected at the gate/by an admin); there is no second online payment at exit and no admin "mark collected" button yet.
- No `EXPLAIN` review and no load test were run; run `autocannon`/k6 against availability and booking before launch.
- Realtime is verified with Socket.IO clients in tests and the API in a real browser session; two-browser manual testing of live updates was not done.
- Not built: email verification, SMS, EV charger entity and charging billing (optional Phase 10b), Redis adapter (documented only).
- Frontend: a pre-existing SSR hydration warning (random idempotency key rendered on the server) and lazy-route Suspense warnings appear in dev console; they are not caused by the API layer.
- 21 pre-existing React-hooks lint *warnings* remain in untouched components; lint has 0 errors.
