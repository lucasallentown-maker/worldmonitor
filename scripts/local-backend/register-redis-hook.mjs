import { register } from 'node:module';

// docker/redis-rest-proxy.mjs imports 'redis'. Node ESM does not honor NODE_PATH,
// so this hook resolves that one specifier to the copy installed next to this file.
register('./redis-hook.mjs', import.meta.url);
