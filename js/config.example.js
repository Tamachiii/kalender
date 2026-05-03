// Template for js/config.js. The real file is gitignored and is generated
// in CI from the SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY repository secrets
// (see .github/workflows/deploy.yml).
//
// Local dev:
//   cp js/config.example.js js/config.js
//   Then replace the two placeholders below with your Supabase project values.

export const SUPABASE_URL = '__SUPABASE_URL__';
export const SUPABASE_PUBLISHABLE_KEY = '__SUPABASE_PUBLISHABLE_KEY__';

export const CATEGORY_COLORS = {
  work: '#3b82f6',
  personal: '#22c55e',
  urgent: '#ef4444',
  focus: '#a855f7',
  travel: '#f59e0b',
};

export const CATEGORIES = Object.keys(CATEGORY_COLORS);

export const BUILT_IN_TAGS = CATEGORIES.map((id) => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  color: CATEGORY_COLORS[id],
  builtIn: true,
}));
