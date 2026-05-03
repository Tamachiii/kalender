// Template for js/config.js. The real file is gitignored and is generated
// in CI from the SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY repository secrets
// (see .github/workflows/deploy.yml).
//
// Local dev:
//   cp js/config.example.js js/config.js
//   Then replace the two placeholders below with your Supabase project values.

export const SUPABASE_URL = '__SUPABASE_URL__';
export const SUPABASE_PUBLISHABLE_KEY = '__SUPABASE_PUBLISHABLE_KEY__';

// Color used to render an event whose tag was deleted between fetches. The
// canonical "Untagged" color lives in the database (see seed_calendar_tags()
// in supabase/schema.sql); this is a client-side fallback only.
export const FALLBACK_TAG_COLOR = '#94a3b8';
export const FALLBACK_TAG_NAME = 'Untagged';
