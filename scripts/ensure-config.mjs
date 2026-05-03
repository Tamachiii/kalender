// Used by `npm test` (and any CI test job) so that importing js/store.js
// does not fail with "Cannot find module './config.js'" on a fresh clone.
// Tests don't need real Supabase credentials — they're never reached, but
// store.js statically imports FALLBACK_TAG_COLOR/NAME from config.js.
//
// On a developer machine that already has a real js/config.js, this is a
// no-op. On CI / a fresh clone, it copies the placeholder example.
import { copyFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('js/config.js');
const example = resolve('js/config.example.js');

try {
  await access(target);
} catch {
  await copyFile(example, target);
  console.log('[ensure-config] Copied js/config.example.js to js/config.js for tests.');
}
