import { workerData, parentPort } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

try {
  const { query, liveDependencies, QueryFailure } = await tsImport('./queries.ts', import.meta.url);
  const { profile, query: request } = workerData;
  try {
    const data = await query(profile, request, liveDependencies(profile));
    parentPort.postMessage({ ok: true, data });
  } catch (err) {
    parentPort.postMessage({ ok: false, code: err instanceof QueryFailure ? err.code : 'unavailable' });
  }
} catch {
  parentPort.postMessage({ ok: false, code: 'unavailable' });
}
