/** `npm run openapi` — writes the generated contract to packages/api-contract. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from './spec.ts';

const out = resolve(import.meta.dirname, '../../../../packages/api-contract/openapi.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');

console.log(`OpenAPI written to ${out}`);
