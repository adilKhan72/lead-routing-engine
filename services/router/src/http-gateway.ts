import { z } from 'zod';
import type { Buyer } from './buyer.ts';
import type { BuyerGateway, DeliveryResult } from './buyer-gateway.ts';
import type { ClaimedLead } from './eligibility.ts';

const AnswerSchema = z.object({ accept: z.boolean(), reason: z.string().max(500).optional() });

export type Phase = 'ping' | 'post';
type Failure = Exclude<DeliveryResult, { result: 'accepted' }>;
type CallResult = { ok: true; accept: boolean; reason: string | undefined } | ({ ok: false } & Failure);

export interface CallObserver {
  (phase: Phase, outcome: 'accepted' | 'rejected' | 'timeout' | 'error', durationMs: number): void;
}

export interface HttpGatewayOptions {
  fetch?: typeof fetch;
  monotonicMs: () => number;
  observe?: CallObserver;
}

/**
 * Ping-post over HTTP (ADR-0004). The ping carries no contact details, only what a buyer needs to decide;
 * the post carries the full lead and happens only after an accepted ping. Each call is bounded by the
 * buyer's own timeout and by what is left of the lead's routing budget, whichever is smaller.
 */
export class HttpPingPostGateway implements BuyerGateway {
  private readonly fetchFn: typeof fetch;
  private readonly monotonicMs: () => number;
  private readonly observe: CallObserver;

  constructor(opts: HttpGatewayOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.monotonicMs = opts.monotonicMs;
    this.observe = opts.observe ?? (() => undefined);
  }

  async deliver(buyer: Buyer, lead: ClaimedLead, budgetMs: number): Promise<DeliveryResult> {
    if (!buyer.endpointUrl) return { result: 'error', reason: 'buyer has no endpoint configured' };
    const base = buyer.endpointUrl.replace(/\/+$/, '');
    const started = this.monotonicMs();

    const ping = await this.call('ping', `${base}/ping`, pingBody(lead), Math.min(buyer.pingTimeoutMs, budgetMs));
    if (!ping.ok) return { result: ping.result, reason: ping.reason };
    if (!ping.accept) return { result: 'rejected', reason: ping.reason ?? 'declined at ping' };

    const remaining = budgetMs - (this.monotonicMs() - started);
    if (remaining <= 0) return { result: 'timeout', reason: 'routing budget spent before post' };
    const postBody = { leadId: lead.id, ...lead.payload };
    const post = await this.call('post', `${base}/post`, postBody, Math.min(buyer.postTimeoutMs, remaining));
    if (!post.ok) return { result: post.result, reason: post.reason };
    return post.accept ? { result: 'accepted' } : { result: 'rejected', reason: post.reason ?? 'declined at post' };
  }

  private async call(phase: Phase, url: string, body: unknown, timeoutMs: number): Promise<CallResult> {
    const started = this.monotonicMs();
    const result = await this.request(url, body, timeoutMs);
    const outcome = result.ok ? (result.accept ? 'accepted' : 'rejected') : result.result;
    this.observe(phase, outcome, this.monotonicMs() - started);
    if (!result.ok) return { ...result, reason: `${phase}: ${result.reason}` };
    return result;
  }

  private async request(url: string, body: unknown, timeoutMs: number): Promise<CallResult> {
    try {
      // The signal also covers reading the body, so a buyer that trickles its response still times out.
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, result: 'error', reason: `HTTP ${res.status}` };
      }
      const parsed = AnswerSchema.safeParse(await res.json());
      if (!parsed.success) return { ok: false, result: 'error', reason: 'malformed response' };
      return { ok: true, accept: parsed.data.accept, reason: parsed.data.reason };
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { ok: false, result: 'timeout', reason: `no answer within ${Math.floor(timeoutMs)} ms` };
      }
      if (err instanceof SyntaxError) return { ok: false, result: 'error', reason: 'response was not JSON' };
      return { ok: false, result: 'error', reason: err instanceof Error ? err.message : 'request failed' };
    }
  }
}

/** What a buyer sees before committing: enough to price the lead, nothing that identifies the consumer. */
export function pingBody(lead: ClaimedLead) {
  return {
    leadId: lead.id,
    product: lead.product,
    state: lead.state,
    zip3: lead.payload.zip.slice(0, 3),
    amountCents: lead.amountCents,
    creditBand: lead.creditBand,
  };
}
