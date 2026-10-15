import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeLead } from '@lre/shared/testing';
import { buildApp } from '../src/app.ts';
import { FakePublisher, InMemoryLeadRepository } from './fakes.ts';

const silent = pino({ level: 'silent' });

function setup() {
  const repo = new InMemoryLeadRepository();
  const publisher = new FakePublisher();
  let n = 0;
  const app = buildApp({ repo, publisher, log: silent, newId: () => `00000000-0000-4000-8000-00000000000${++n}` });
  const post = (body: unknown, key: string | null = 'key-00000001') =>
    app.inject({ method: 'POST', url: '/v1/leads', payload: body as object, headers: key ? { 'idempotency-key': key } : {} });
  return { repo, publisher, app, post };
}

describe('POST /v1/leads', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('accepts a valid lead, stores it and publishes it', async () => {
    const res = await ctx.post(makeLead());
    expect(res.statusCode).toBe(202);
    const body = res.json<{ leadId: string; status: string }>();
    expect(body).toEqual({ leadId: '00000000-0000-4000-8000-000000000001', status: 'received' });
    expect(res.headers.location).toBe(`/v1/leads/${body.leadId}`);
    expect(ctx.publisher.published).toEqual([body.leadId]);
    expect((await ctx.repo.findById(body.leadId))?.publishedAt).not.toBeNull();
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await ctx.post(makeLead(), null);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_idempotency_key' });
  });

  it('returns field-level validation issues', async () => {
    const res = await ctx.post({ ...makeLead(), state: 'XX' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_lead', issues: [{ path: 'state' }] });
    expect(ctx.publisher.published).toEqual([]);
  });

  it('replays the original response for a retried request without re-publishing', async () => {
    const first = await ctx.post(makeLead());
    const second = await ctx.post(makeLead());
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(ctx.publisher.published).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    await ctx.post(makeLead());
    const res = await ctx.post(makeLead({ zip: '10001' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'idempotency_key_reused' });
  });

  it('still accepts the lead when the broker is down, leaving it for the sweeper', async () => {
    ctx.publisher.failing = true;
    const res = await ctx.post(makeLead());
    expect(res.statusCode).toBe(202);
    const { leadId } = res.json<{ leadId: string }>();
    expect((await ctx.repo.findById(leadId))?.publishedAt).toBeNull();
  });

  it('gives a replay a second chance to publish a lead whose first publish failed', async () => {
    ctx.publisher.failing = true;
    await ctx.post(makeLead());
    ctx.publisher.failing = false;
    await ctx.post(makeLead());
    expect(ctx.publisher.published).toHaveLength(1);
  });

  it('rejects bodies over 16 KiB', async () => {
    const res = await ctx.post({ ...makeLead(), source: { publisherId: 'x'.repeat(20_000) } });
    expect(res.statusCode).toBe(413);
  });
});

describe('GET /v1/leads/:id', () => {
  it('returns the lead status', async () => {
    const { post, app } = setup();
    const { leadId } = (await post(makeLead())).json<{ leadId: string }>();
    const res = await app.inject({ method: 'GET', url: `/v1/leads/${leadId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ leadId, status: 'received' });
  });

  it('404s for unknown or malformed ids', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/leads/not-a-uuid' })).statusCode).toBe(404);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await app.inject({ method: 'GET', url: `/v1/leads/${unknown}` })).statusCode).toBe(404);
  });
});

describe('probes', () => {
  it('reports not ready when a dependency is down', async () => {
    const app = buildApp({
      repo: new InMemoryLeadRepository(),
      publisher: new FakePublisher(),
      log: silent,
      ready: () => Promise.reject(new Error('db down')),
    });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });
});
