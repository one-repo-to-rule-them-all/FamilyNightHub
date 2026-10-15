# Family Night Hub

Next.js (App Router) + Supabase (Postgres, Auth, RLS) deployed on Vercel.

## Local development

1. `npm install`
2. `cp .env.example .env.local`
3. `npm run db:start` (needs Docker) and paste the printed API URL and publishable key into `.env.local`
4. `npm run dev` then open http://localhost:3000

Useful: `npm run db:reset` re-applies migrations and `supabase/seed.sql`; `npm run db:types` regenerates TypeScript types.

## Supabase (hosted)

1. Create a project at supabase.com.
2. `npx supabase login && npx supabase link --project-ref <ref>`
3. `npx supabase db push` to apply `supabase/migrations`.
4. In Auth settings, add your Vercel URL(s) to Site URL / Redirect URLs.

## Vercel

1. Import this repo at vercel.com/new (framework is detected from `vercel.json`).
2. Add env vars for Production and Preview:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only)
3. Deploy. Every push to `main` deploys to production; PRs get preview URLs.

## Layout

- `src/lib/supabase/` - browser, server and proxy (session refresh) clients
- `src/proxy.ts` - Next 16 proxy (formerly middleware) that refreshes auth cookies
- `supabase/migrations/` - schema and RLS policies
