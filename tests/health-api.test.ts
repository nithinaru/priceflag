import assert from 'node:assert/strict';

import { GET } from '../app/api/health/route';
import { DemoAdapter, setAdapter } from '../lib/adapters';

process.env.PRICEFLAG_MODE = 'demo';

async function responseBody(): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await GET();
  return { response, body: (await response.json()) as Record<string, any> };
}

async function main(): Promise<void> {
  const adapter = DemoAdapter.ephemeral(909);
  setAdapter(adapter);

  const healthy = await responseBody();
  assert.equal(healthy.response.status, 200);
  assert.equal(healthy.response.headers.get('cache-control'), 'no-store');
  assert.equal(healthy.body.ok, true);
  assert.equal(healthy.body.adapter.ok, true);
  assert.equal(healthy.body.adapter.detail, 'reachable');

  adapter.ping = async () => ({
    ok: false,
    detail: 'private-db.internal:5432 connection refused with secret metadata',
  });
  const unavailable = await responseBody();
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.response.headers.get('cache-control'), 'no-store');
  assert.equal(unavailable.body.ok, false);
  assert.equal(unavailable.body.adapter.detail, 'unreachable');
  assert.doesNotMatch(JSON.stringify(unavailable.body), /private-db|secret metadata|5432/);

  adapter.ping = async () => ({
    ok: false,
    detail: 'connected, but required schema migrations are missing',
  });
  const stale = await responseBody();
  assert.equal(stale.response.status, 503);
  assert.equal(stale.body.adapter.detail, 'reachable, but database migrations are missing');

  const previousTimeout = process.env.PRICEFLAG_HEALTH_TIMEOUT_MS;
  process.env.PRICEFLAG_HEALTH_TIMEOUT_MS = '10';
  adapter.ping = async () => await new Promise(() => undefined);
  try {
    const started = Date.now();
    const timedOut = await responseBody();
    assert.equal(timedOut.response.status, 503);
    assert.equal(timedOut.body.adapter.detail, 'unreachable');
    assert.ok(Date.now() - started < 500, 'health deadline did not return promptly');
  } finally {
    if (previousTimeout === undefined) delete process.env.PRICEFLAG_HEALTH_TIMEOUT_MS;
    else process.env.PRICEFLAG_HEALTH_TIMEOUT_MS = previousTimeout;
  }

  setAdapter(null);
  console.log('Health API: deadline, no-store readiness, status, schema diagnosis and error redaction passed.');
}

void main();
