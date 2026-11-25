# ParkGrid One: smart parking

Express 5 + PostgreSQL backend (`backend/`) replacing Supabase, wired to the original TanStack Start frontend (`frontend/`).

Journey: sign up → add vehicle → pick a bay → hold → pay (mock or Razorpay) → confirmation with an opaque QR pass → staff scans entry → live session → staff scans exit (overstay charged) → receipt and notifications. Admin console, realtime availability and a grounded parking assistant included.

| Folder | What |
|---|---|
| `backend/` | API, migrations, seeds, tests (101), Dockerfile |
| `frontend/` | the existing app; `src/lib/api/*` is the new API client, `src/routes/gate.tsx` the staff scanner |
| `render.yaml` + `docs/DEPLOY-FREE.md` | free-tier demo deployment (Neon + Render + Cloudflare) |
| `docs/` | `ARCHITECTURE` · `API` · `DATABASE` · `PAYMENTS` · `REALTIME` · `RAG` · `SECURITY` · `RUNBOOK` · `LEARNING` · `AUDIT`; `legacy-supabase/` keeps the original SQL |
| `.github/workflows/` | CI and (optional) deploy |

Quick start and deployment: [docs/RUNBOOK.md](docs/RUNBOOK.md). What was found wrong in the original and what changed: [docs/AUDIT.md](docs/AUDIT.md). Honest limitations: end of RUNBOOK.
