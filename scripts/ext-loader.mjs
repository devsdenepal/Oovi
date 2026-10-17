import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// src/ uses bundler-style extensionless relative imports. This hook lets
// plain-node scripts import those modules by trying .js/.mjs.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || path.extname(specifier)) throw error;
    const parentPath = fileURLToPath(context.parentURL);
    for (const ext of ['.js', '.mjs']) {
      const full = path.resolve(path.dirname(parentPath), specifier + ext);
      if (existsSync(full)) return { url: pathToFileURL(full).href, shortCircuit: true };
    }
    throw error;
  }
}
