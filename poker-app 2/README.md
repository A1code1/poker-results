# ♠️ Poker Results App

Upload a photo of your handwritten poker score sheet → review players → calculate payouts → share.

---

## Deploy in 15 minutes

### Step 1 — Get the code running locally

```bash
npm install
cp .env.example .env.local
# Fill in .env.local with your values (see below)
npm run dev
# Open http://localhost:3000
```

---

### Step 2 — Create a Supabase database (free)

1. Go to [supabase.com](https://supabase.com) → New project (free tier is fine)
2. Once created, go to **SQL Editor** → **New query**
3. Paste the contents of `supabase-schema.sql` and click **Run**
4. Go to **Settings → API** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

---

### Step 3 — Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Copy it → `ANTHROPIC_API_KEY`

---

### Step 4 — Fill in .env.local

```
NEXT_PUBLIC_PASSCODE=choose-any-passcode
ANTHROPIC_API_KEY=sk-ant-...
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

---

### Step 5 — Deploy to Vercel (free)

```bash
npm i -g vercel
vercel
```

Follow the prompts (link to your GitHub or deploy directly).

Then in the **Vercel dashboard → your project → Settings → Environment Variables**, add the same 4 variables from your `.env.local`.

Redeploy once after adding the env vars:

```bash
vercel --prod
```

Your app is now live at `https://your-project.vercel.app` 🎉

---

## Environment variables summary

| Variable | Where to get it | Public? |
|---|---|---|
| `NEXT_PUBLIC_PASSCODE` | Choose anything | Yes (in browser) |
| `ANTHROPIC_API_KEY` | console.anthropic.com | **No** — server only |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API | Yes |

> ⚠️ `ANTHROPIC_API_KEY` must NOT have the `NEXT_PUBLIC_` prefix — it stays server-side only and is never exposed to the browser.

---

## Project structure

```
poker-app/
├── app/
│   ├── page.tsx              # Passcode gate
│   ├── layout.tsx            # Root layout
│   ├── globals.css
│   ├── game/
│   │   └── page.tsx          # Main app (auth-protected)
│   └── api/
│       └── ocr/
│           └── route.ts      # Server-side Anthropic OCR calls
├── components/
│   ├── AuthGuard.tsx         # Redirects to gate if not authed
│   └── PokerApp.tsx          # Full app (all screens)
├── lib/
│   └── supabase.ts           # Supabase client
├── supabase-schema.sql       # Run this once in Supabase SQL editor
└── .env.example              # Copy to .env.local
```
