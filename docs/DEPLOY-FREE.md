# Free demo deployment (portfolio)

Goal: a public link recruiters can click, at **₹0**. Stack: **Neon** (Postgres + pgvector) · **Render** free web service (API) · **Cloudflare** (web app). Payments stay on the **mock gateway**, so nobody can spend real money; Razorpay test mode is optional.

## 1. Database (Neon)
1. Create a free project at neon.tech. Copy the connection string and make sure it ends with `?sslmode=require`.
2. Nothing else: the API creates tables, the parking layout, the knowledge base and demo logins on first boot (`BOOTSTRAP_ON_BOOT=true`; migrations run on every start).

## 2. API (Render)
1. Push the repo to GitHub (you create the repo and push yourself).
2. Render → New → **Blueprint** → pick the repo (`render.yaml` is at the root).
3. Fill the prompted values: `DATABASE_URL` (Neon), `DEMO_PASSWORD` (the shared password for the demo logins), `CORS_ORIGINS` and `APP_URL` (your web app URL, you can fill these after step 3), optional `GROQ_API_KEY`.
4. Check `https://<service>.onrender.com/healthz` returns `{"status":"ok"}`.

Free-tier behaviour: the service sleeps after ~15 min idle, so the first request after a pause takes ~30–60 s (the web app shows normal loading states). Background jobs only run while awake; expired holds are also cleaned on every read, so behaviour stays correct.

## 3. Web app (Cloudflare)
```powershell
cd frontend
$env:VITE_API_URL="https://<service>.onrender.com"; npm run build
npx nitro deploy --prebuilt     # needs `npx wrangler login` once
```
Then put the resulting URL into Render's `CORS_ORIGINS` and `APP_URL` and redeploy the API.
(`.github/workflows/deploy.yml` can automate this once you add the secrets; it skips itself until then.)

## 4. Demo logins (put these in the project README)
| Role | Email | What to try |
|---|---|---|
| Driver | `demo.member@parkgrid.demo` | book a bay, pay with the mock gateway, see the QR |
| Gate staff | `demo.staff@parkgrid.demo` | `/gate` scanner (type the `PG1:` code if no camera) |
| Admin | `demo.admin@parkgrid.demo` | dashboard, users, refunds, audit log, knowledge base |

Password = the `DEMO_PASSWORD` you set. Anyone can use the admin demo login, so expect your demo data to get messy; wipe it by recreating the Neon branch. Never reuse a real password.

## 5. Optional upgrades
- **Real assistant text**: add `GROQ_API_KEY` (free). Retrieval still uses the offline embedder.
- **Razorpay test mode**: `PAYMENT_PROVIDER=razorpay` plus the three Razorpay test values and a webhook pointing at `/webhooks/razorpay` (see `PAYMENTS.md`). Test keys only.

## 6. Resume / LinkedIn blurb
> **ParkGrid One**: full-stack smart-parking platform (React 19 / TanStack Start, Express 5, PostgreSQL + pgvector). Double-booking prevented by an exclusion constraint plus row locking (verified with 25 concurrent requests), Razorpay order/verify/webhook flow with idempotent confirmation and auto-refunds, opaque QR gate entry/exit, Postgres LISTEN/NOTIFY → Socket.IO realtime, and a RAG assistant with live-data tools. 101 automated tests on real Postgres, CI on GitHub Actions.
