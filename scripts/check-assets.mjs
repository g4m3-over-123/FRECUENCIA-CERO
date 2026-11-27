// Fails when a file under public/ is larger than the agreed limit (default 15 MB).
// Usage: npm run check:assets [-- --max-mb 15]
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const flag = process.argv.indexOf('--max-mb');
const maxMb = flag >= 0 ? Number(process.argv[flag + 1]) : 15;
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (statSync(path).size > maxMb * 1024 * 1024) offenders.push([path, statSync(path).size]);
  }
}

walk('public');
if (offenders.length === 0) {
  console.log(`OK: no file in public/ exceeds ${maxMb} MB`);
} else {
  for (const [path, size] of offenders) console.error(`TOO BIG: ${path} (${(size / 1048576).toFixed(1)} MB)`);
  console.error('Compress it (e.g. npx @gltf-transform/cli optimize in.glb out.glb --texture-size 1024) before committing.');
  process.exit(1);
}
