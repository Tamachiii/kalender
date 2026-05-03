import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';

const AUTH_STORAGE_KEY = 'shared-calendar-auth-v2';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    storageKey: AUTH_STORAGE_KEY,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});
