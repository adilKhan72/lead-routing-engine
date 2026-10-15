-- Buyers: who can buy leads, at what price, with which filters, caps and schedule.
CREATE TABLE buyers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text        NOT NULL,
  active           boolean     NOT NULL DEFAULT true,
  price_cents      integer     NOT NULL CHECK (price_cents > 0),
  weight           integer     NOT NULL DEFAULT 1 CHECK (weight > 0),
  -- Filters, validated by the application (see packages/shared/src/buyer.ts).
  -- JSONB rather than a filter table: filters are always read together with the buyer.
  criteria         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- NULL schedule = always open. Otherwise {"days":[1..7], "startHour":0..23, "endHour":1..24}.
  schedule         jsonb,
  timezone         text        NOT NULL DEFAULT 'UTC',
  hourly_cap       integer     CHECK (hourly_cap > 0),
  daily_cap        integer     CHECK (daily_cap > 0),
  endpoint_url     text,
  ping_timeout_ms  integer     NOT NULL DEFAULT 300 CHECK (ping_timeout_ms > 0),
  post_timeout_ms  integer     NOT NULL DEFAULT 500 CHECK (post_timeout_ms > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX buyers_active_idx ON buyers (price_cents DESC) WHERE active;

CREATE TYPE lead_status AS ENUM ('received', 'routing', 'sold', 'unsold', 'failed');

-- Leads double as the outbox: published_at IS NULL until the stream XADD succeeded.
CREATE TABLE leads (
  id               uuid PRIMARY KEY,
  idempotency_key  text        NOT NULL UNIQUE,
  payload_hash     text        NOT NULL,
  product          text        NOT NULL,
  state            char(2)     NOT NULL,
  amount_cents     bigint,
  credit_band      text        NOT NULL,
  payload          jsonb       NOT NULL,
  status           lead_status NOT NULL DEFAULT 'received',
  received_at      timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  -- Routing lease: which worker owns the lead and until when (fencing via claim_token).
  claim_token      uuid,
  lease_until      timestamptz,
  routing_attempts integer     NOT NULL DEFAULT 0,
  decided_at       timestamptz
);

CREATE INDEX leads_unpublished_idx ON leads (received_at) WHERE published_at IS NULL;
CREATE INDEX leads_open_idx ON leads (received_at) WHERE status IN ('received', 'routing');

-- Cap counters, one row per (buyer, window). Reserved with a conditional upsert (ADR-0002).
CREATE TABLE buyer_cap_usage (
  buyer_id      uuid        NOT NULL REFERENCES buyers (id) ON DELETE CASCADE,
  window_kind   text        NOT NULL CHECK (window_kind IN ('hour', 'day')),
  window_start  timestamptz NOT NULL,
  used          integer     NOT NULL CHECK (used >= 0),
  PRIMARY KEY (buyer_id, window_kind, window_start)
);

-- One final decision per lead; the unique constraint is the last line of defence against double-selling.
CREATE TABLE routing_decisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id      uuid        NOT NULL UNIQUE REFERENCES leads (id),
  outcome      text        NOT NULL CHECK (outcome IN ('sold', 'unsold', 'failed')),
  buyer_id     uuid        REFERENCES buyers (id),
  price_cents  integer,
  -- Per-buyer attempt log: [{buyerId, result, reason, latencyMs}]
  attempts     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  latency_ms   integer,
  decided_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'sold') = (buyer_id IS NOT NULL AND price_cents IS NOT NULL))
);

CREATE INDEX routing_decisions_buyer_idx ON routing_decisions (buyer_id, created_at) WHERE outcome = 'sold';
