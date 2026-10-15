// k6 load test for the ingest edge. Routing latency is measured separately, from the decisions the
// routers record in Postgres (see loadtest/report.sql), because k6 only sees the 202.
//
//   k6 run -e BASE_URL=http://localhost:3000 -e RATE=200 -e DURATION=60s loadtest/ingest.js
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '60s';
// Fraction of requests that re-send an earlier request with the same Idempotency-Key (publisher retries).
const REPLAY_RATIO = Number(__ENV.REPLAY_RATIO || 0.05);

export const options = {
  scenarios: {
    leads: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, Math.ceil(RATE / 4)),
      maxVUs: Math.max(50, RATE * 2),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{expected_response:true}': ['p(95)<250'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const STATES = ['TX', 'CA', 'FL', 'NY', 'GA', 'AZ', 'OK', 'WA', 'OH', 'IL'];
const BANDS = ['excellent', 'good', 'fair', 'poor'];
const runId = `${Date.now()}`;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function lead() {
  const loan = Math.random() < 0.7;
  return {
    product: loan ? 'personal_loan' : 'auto_insurance',
    state: pick(STATES),
    zip: String(10000 + Math.floor(Math.random() * 89999)),
    ...(loan ? { amountCents: 100000 + Math.floor(Math.random() * 4900000) } : {}),
    creditBand: pick(BANDS),
    contact: { firstName: 'Load', lastName: 'Test', email: 'load@example.com', phone: '+15555550123' },
    consent: { tcpa: true, capturedAt: new Date().toISOString() },
    source: { publisherId: 'k6' },
  };
}

// Requests this VU already sent, so a replay re-sends an identical (key, body) pair like a retrying publisher.
const sent = [];

export default function () {
  const replay = sent.length > 0 && Math.random() < REPLAY_RATIO;
  const request = replay
    ? sent[Math.floor(Math.random() * sent.length)]
    : { key: `k6-${runId}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`, body: JSON.stringify(lead()) };
  if (!replay && sent.length < 100) sent.push(request);

  const res = http.post(`${BASE_URL}/v1/leads`, request.body, {
    headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
    tags: { replay: String(replay) },
  });
  check(res, {
    'status is 202': (r) => r.status === 202,
    'replays are flagged': (r) => !replay || r.headers['Idempotent-Replayed'] === 'true',
  });
}
