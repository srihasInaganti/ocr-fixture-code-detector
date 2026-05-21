# OCR Fixture Code Detector

Upload an electrical lighting plan PDF, render a page at high resolution, OCR
the page, and surface only lighting-fixture codes (LF1–LF15, LF7-X) with
pixel bounding boxes drawn over the rendered drawing.

Monorepo:

- `backend/` — FastAPI service (deployed to Render).
- `frontend/` — Vite + React + TypeScript SPA (deployed to Vercel).

## Local development

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 8000
```

Verify: <http://localhost:8000/health> returns `{"status":"ok"}`.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:5173>. The page should display the backend health
JSON.

## Deploy

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
# create an empty repo on GitHub, then:
git remote add origin git@github.com:<you>/ocr-fixture-code-detector.git
git push -u origin main
```

### 2. Deploy the backend to Render

1. Go to <https://dashboard.render.com> → **New +** → **Web Service**.
2. Connect the GitHub repo.
3. Render should detect `backend/render.yaml`. If not, configure manually:
   - **Root Directory:** `backend`
   - **Runtime:** Python
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan:** Free
4. Under **Environment**, set `ALLOWED_ORIGINS` to your Vercel URL once you
   have it (leave blank for now and update after step 3, or temporarily set
   `*` for a first smoke test).
5. Deploy. Hit `https://<your-service>.onrender.com/health` — you should see
   `{"status":"ok"}`.

> Render's free tier sleeps when idle. The first request after a cold start
> can take 30–60 seconds.

### 3. Deploy the frontend to Vercel

1. Go to <https://vercel.com/new> and import the same GitHub repo.
2. Project setup:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite (auto-detected)
   - **Build Command:** `npm run build` (default)
   - **Output Directory:** `dist` (default)
3. Environment Variables:
   - `VITE_API_BASE_URL` = `https://<your-render-service>.onrender.com`
4. Deploy.

### 4. Lock CORS to your Vercel URL

In the Render dashboard, set:

```
ALLOWED_ORIGINS=https://<your-app>.vercel.app
```

Trigger a redeploy.

### 5. Verify

Open your Vercel URL. The page should show the API base URL it's calling
and a "Backend health" section displaying `{"status":"ok"}` returned from
Render.

If you see a CORS error in the browser console, `ALLOWED_ORIGINS` on Render
does not match the actual Vercel URL — fix it and redeploy the backend.

## Environment variables

| Side     | Variable             | Purpose                                |
|----------|----------------------|----------------------------------------|
| Backend  | `ALLOWED_ORIGINS`    | Comma-separated CORS origins.          |
| Frontend | `VITE_API_BASE_URL`  | Base URL of the FastAPI backend.       |
