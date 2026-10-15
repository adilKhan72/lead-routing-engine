import type { HandlerResult, StreamConsumerHooks } from './stream-consumer.ts';
import { routeLead, type RouteOutcome, type RouterDeps } from './route-lead.ts';

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

export function routerHooks(deps: RouterDeps): StreamConsumerHooks {
  return {
    async handle(leadId) {
      const outcome = await routeLead(deps, leadId);
      deps.log.info({ leadId, outcome }, 'lead routed');
      return toHandlerResult(outcome);
    },
    async onDeadLetter(leadId, reason) {
      if (leadId) await deps.leads.markFailed(leadId, deps.workerName, reason);
    },
  };
}
