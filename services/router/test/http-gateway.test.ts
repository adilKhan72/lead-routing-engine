import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpPingPostGateway, type Phase } from '../src/http-gateway.ts';
import { makeBuyer, makeRoutableLead } from './fakes.ts';

type Responder = (phase: string, body: Record<string, unknown>, res: ServerResponse) => void;

/** A real HTTP server whose behaviour each test scripts, so timeouts and malformed answers are genuine. */
describe('HttpPingPostGateway', () => {
  let server: Server;
  let baseUrl: string;
  let respond: Responder;
  const received: { phase: string; body: Record<string, unknown> }[] = [];
  const observed: [Phase, string][] = [];
  const gateway = new HttpPingPostGateway({
    monotonicMs: () => performance.now(),
    observe: (phase, outcome) => observed.push([phase, outcome]),
  });

  const json = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const phase = (req.url ?? '').split('/').pop() ?? '';
        const body = JSON.parse(raw) as Record<string, unknown>;
        received.push({ phase, body });
        respond(phase, body, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/buyer-a`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    received.length = 0;
    observed.length = 0;
    respond = (_phase, _body, res) => {
      json(res, 200, { accept: true });
    };
  });

  const buyer = (overrides = {}) => makeBuyer({ endpointUrl: baseUrl, pingTimeoutMs: 200, postTimeoutMs: 200, ...overrides });

  it('pings without contact details, then posts the full lead', async () => {
    const lead = makeRoutableLead();
    expect(await gateway.deliver(buyer(), lead, 2_000)).toEqual({ result: 'accepted' });
    expect(received.map((r) => r.phase)).toEqual(['ping', 'post']);
    expect(received[0]!.body).toEqual({
      leadId: lead.id,
      product: 'personal_loan',
      state: 'TX',
      zip3: '733',
      amountCents: 1_500_000,
      creditBand: 'good',
    });
    expect(received[1]!.body).toMatchObject({ leadId: lead.id, contact: { email: 'ada@example.com' } });
    expect(observed).toEqual([
      ['ping', 'accepted'],
      ['post', 'accepted'],
    ]);
  });

  it('does not post after a declined ping', async () => {
    respond = (_p, _b, res) => {
      json(res, 200, { accept: false, reason: 'state not wanted' });
    };
    expect(await gateway.deliver(buyer(), makeRoutableLead(), 2_000)).toEqual({
      result: 'rejected',
      reason: 'state not wanted',
    });
    expect(received).toHaveLength(1);
  });

  it('times out a slow buyer at its own ping timeout', async () => {
    respond = (_p, _b, res) => setTimeout(() => {
      json(res, 200, { accept: true });
    }, 300);
    const started = performance.now();
    const result = await gateway.deliver(buyer({ pingTimeoutMs: 50 }), makeRoutableLead(), 2_000);
    expect(result).toMatchObject({ result: 'timeout' });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('caps the call at the remaining routing budget when that is tighter', async () => {
    respond = (_p, _b, res) => setTimeout(() => {
      json(res, 200, { accept: true });
    }, 300);
    expect(await gateway.deliver(buyer({ pingTimeoutMs: 5_000 }), makeRoutableLead(), 60)).toEqual({
      result: 'timeout',
      reason: 'ping: no answer within 60 ms',
    });
  });

  it('treats a post timeout as a failed delivery', async () => {
    respond = (phase, _b, res) => {
      if (phase === 'ping') json(res, 200, { accept: true });
      else setTimeout(() => {
        json(res, 200, { accept: true });
      }, 300);
    };
    expect(await gateway.deliver(buyer({ postTimeoutMs: 50 }), makeRoutableLead(), 2_000)).toMatchObject({
      result: 'timeout',
      reason: expect.stringMatching(/^post:/) as unknown,
    });
  });

  it.each([
    ['an HTTP 503', (res: ServerResponse) => json(res, 503, { error: 'down' }), 'ping: HTTP 503'],
    ['a malformed answer', (res: ServerResponse) => json(res, 200, { yes: 1 }), 'ping: malformed response'],
    ['non-JSON', (res: ServerResponse) => res.writeHead(200).end('OK'), 'ping: response was not JSON'],
  ])('maps %s to an error', async (_name, reply, reason) => {
    respond = (_p, _b, res) => {
      reply(res);
    };
    expect(await gateway.deliver(buyer(), makeRoutableLead(), 2_000)).toEqual({ result: 'error', reason });
  });

  it('reports unreachable or unconfigured endpoints as errors', async () => {
    expect(await gateway.deliver(buyer({ endpointUrl: 'http://127.0.0.1:9/x' }), makeRoutableLead(), 2_000)).toMatchObject({
      result: 'error',
    });
    expect(await gateway.deliver(buyer({ endpointUrl: null }), makeRoutableLead(), 2_000)).toEqual({
      result: 'error',
      reason: 'buyer has no endpoint configured',
    });
  });
});
