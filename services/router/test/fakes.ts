import { pino } from 'pino';
import type { Buyer } from '../src/buyer.ts';
import type { BuyerGateway, DeliveryResult } from '../src/buyer-gateway.ts';
import type { BuyerSource } from '../src/buyer-source.ts';
import { capWindows, type CapStore, type Reservation } from '../src/caps.ts';
import { makeLead } from '@lre/shared/testing';
import type { ClaimedLead } from '../src/eligibility.ts';
import type { ClaimResult, Decision, LeadStore } from '../src/lead-store.ts';
import type { RouterDeps } from '../src/route-lead.ts';
import { seededRng } from '../src/selection.ts';

export const silent = pino({ level: 'silent' });

let buyerSeq = 0;
export function makeBuyer(overrides: Partial<Buyer> = {}): Buyer {
  buyerSeq++;
  return {
    id: `buyer-${buyerSeq}`,
    name: `Buyer ${buyerSeq}`,
    priceCents: 1_000,
    weight: 1,
    criteria: {},
    schedule: null,
    timezone: 'UTC',
    hourlyCap: null,
    dailyCap: null,
    endpointUrl: null,
    pingTimeoutMs: 300,
    postTimeoutMs: 500,
    ...overrides,
  };
}

export function makeRoutableLead(overrides: Partial<ClaimedLead> = {}): ClaimedLead {
  return {
    id: 'lead-1',
    product: 'personal_loan',
    state: 'TX',
    amountCents: 1_500_000,
    creditBand: 'good',
    payload: makeLead(),
    ...overrides,
  };
}

export class InMemoryLeadStore implements LeadStore {
  readonly leads = new Map<string, { lead: ClaimedLead; status: string; token: string | null }>();
  readonly decisions = new Map<string, Decision>();
  readonly failed = new Map<string, string>();
  /** Simulates another worker taking over between claim and finalize. */
  stealLeaseOnFinalize = false;

  add(lead: ClaimedLead, status = 'received'): void {
    this.leads.set(lead.id, { lead, status, token: null });
  }

  claim(leadId: string, token: string): Promise<ClaimResult> {
    const row = this.leads.get(leadId);
    if (!row) return Promise.resolve({ kind: 'missing' });
    if (row.status === 'routing') return Promise.resolve({ kind: 'busy' });
    if (row.status !== 'received') return Promise.resolve({ kind: 'final', status: row.status });
    row.status = 'routing';
    row.token = token;
    return Promise.resolve({ kind: 'claimed', lead: row.lead });
  }

  finalize(leadId: string, token: string, decision: Decision): Promise<boolean> {
    const row = this.leads.get(leadId);
    if (this.stealLeaseOnFinalize && row) row.token = 'someone-else';
    if (row?.status !== 'routing' || row.token !== token) return Promise.resolve(false);
    row.status = decision.outcome;
    this.decisions.set(leadId, decision);
    return Promise.resolve(true);
  }

  markFailed(leadId: string, _by: string, reason: string): Promise<void> {
    const row = this.leads.get(leadId);
    if (row && (row.status === 'received' || row.status === 'routing')) {
      row.status = 'failed';
      this.failed.set(leadId, reason);
    }
    return Promise.resolve();
  }
}

export class InMemoryCapStore implements CapStore {
  readonly used = new Map<string, number>();

  reserve(buyer: Buyer, now: Date): Promise<Reservation | null> {
    const windows = capWindows(buyer, now);
    if (windows.some((w) => (this.used.get(key(buyer.id, w.kind)) ?? 0) >= w.limit)) return Promise.resolve(null);
    for (const w of windows) this.used.set(key(buyer.id, w.kind), (this.used.get(key(buyer.id, w.kind)) ?? 0) + 1);
    return Promise.resolve({ buyerId: buyer.id, windows });
  }

  release(r: Reservation): Promise<void> {
    for (const w of r.windows) this.used.set(key(r.buyerId, w.kind), (this.used.get(key(r.buyerId, w.kind)) ?? 1) - 1);
    return Promise.resolve();
  }
}

function key(buyerId: string, kind: string): string {
  return `${buyerId}:${kind}`;
}

export class StaticBuyerSource implements BuyerSource {
  buyers: Buyer[];
  constructor(buyers: Buyer[]) {
    this.buyers = buyers;
  }
  activeBuyers(): Promise<Buyer[]> {
    return Promise.resolve(this.buyers);
  }
}

/** Answers per buyer id (default: accept) and records the call order. */
export class ScriptedGateway implements BuyerGateway {
  readonly calls: string[] = [];
  readonly script = new Map<string, DeliveryResult | Error>();
  onCall?: (buyer: Buyer) => void;

  deliver(buyer: Buyer): Promise<DeliveryResult> {
    this.calls.push(buyer.id);
    this.onCall?.(buyer);
    const scripted = this.script.get(buyer.id) ?? { result: 'accepted' };
    return scripted instanceof Error ? Promise.reject(scripted) : Promise.resolve(scripted);
  }
}

export function makeDeps(buyers: Buyer[], overrides: Partial<RouterDeps> = {}) {
  const leads = new InMemoryLeadStore();
  const caps = new InMemoryCapStore();
  const gateway = new ScriptedGateway();
  const clock = { ms: 0 };
  const deps: RouterDeps = {
    leads,
    caps,
    gateway,
    buyers: new StaticBuyerSource(buyers),
    log: silent,
    now: () => new Date('2026-10-15T15:00:00Z'), // a Thursday
    monotonicMs: () => clock.ms,
    rng: seededRng(42),
    newToken: () => 'token-1',
    workerName: 'test-worker',
    budgetMs: 2_000,
    leaseMs: 10_000,
    ...overrides,
  };
  return { deps, leads, caps, gateway, clock };
}
