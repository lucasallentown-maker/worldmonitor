import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'redis') {
    return {
      url: pathToFileURL(require.resolve('redis')).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
