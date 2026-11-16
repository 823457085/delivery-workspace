import { fileURLToPath } from 'node:url';
import { buildApplication } from '../_shared/build.mjs';
await buildApplication(fileURLToPath(new URL('.', import.meta.url)), 'ServicePlugin');
