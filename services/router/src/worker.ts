import type { RouterMetrics } from './metrics.ts';
import { routeLead, type RouteOutcome, type RouterDeps } from './route-lead.ts';
import type { HandlerResult, StreamConsumerHooks } from './stream-consumer.ts';

export function toHandlerResult(outcome: RouteOutcome): HandlerResult {
  switch (outcome.kind) {
    case 'busy':
      return 'retry';
    case 'missing':
      // The outbox commits the lead before publishing it, so a missing row is a data problem, not a race.
      return { deadLetter: 'lead not found' };
    default:
      return 'ack';
  }
}

export function routerHooks(deps: RouterDeps, metrics?: RouterMetrics): StreamConsumerHooks {
  return {
    async handle(leadId) {
      const started = deps.monotonicMs();
      let outcome: RouteOutcome;
      try {
        outcome = await routeLead(deps, leadId);
      } catch (err) {
        metrics?.observeError();
        throw err;
      }
      metrics?.observeRouting(outcome, (deps.monotonicMs() - started) / 1000);
      deps.log.info({ leadId, outcome }, 'lead routed');
      return toHandlerResult(outcome);
    },
    async onDeadLetter(leadId, reason) {
      metrics?.observeDeadLetter();
      if (leadId) await deps.leads.markFailed(leadId, deps.workerName, reason);
    },
  };
}
