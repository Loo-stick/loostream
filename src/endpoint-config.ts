import * as fs from 'fs';
import * as path from 'path';

// A hot-reloaded single-file endpoint config, mirroring how Movix and
// FrenchStream externalise their domains: a JSON file under config/ (bind-mounted
// in docker-compose, so it can be edited WITHOUT a rebuild), watched for changes,
// with an env override of the path and a defaults fallback.
//
// Lets a self-hoster update a source's base URL when its domain rotates by
// editing one file — no code change, no rebuild, and (thanks to fs.watch) no
// restart. A reload endpoint can also call `reload()` on demand.
export function makeEndpointConfig<T extends Record<string, unknown>>(
  fileName: string,
  envVar: string,
  defaults: T,
): { get: () => T; reload: () => T } {
  const configPath = process.env[envVar] ||
    (fs.existsSync(`/app/config/${fileName}`)
      ? `/app/config/${fileName}`
      : path.join(process.cwd(), 'config', fileName));

  let current: T = { ...defaults };

  const load = (): T => {
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        // Merge over defaults so a partial file (or an unknown extra key like a
        // _comment) never drops a required field.
        current = { ...defaults, ...raw };
      } else {
        current = { ...defaults };
      }
    } catch (e: any) {
      console.error(`[EndpointConfig] ${fileName}: ${e.message} — using defaults`);
      current = { ...defaults };
    }
    return current;
  };

  load();

  try {
    if (fs.existsSync(configPath)) {
      fs.watch(configPath, (eventType) => {
        if (eventType === 'change') {
          console.log(`[EndpointConfig] ${fileName} changed, reloading...`);
          setTimeout(load, 100);
        }
      });
    }
  } catch {
    // fs.watch unsupported on this platform — reload stays available via endpoint
  }

  return { get: () => current, reload: load };
}
