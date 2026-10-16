-- M5: reconciliation bookkeeping (ADR-0006).
ALTER TABLE leads
  ADD COLUMN republish_count     integer     NOT NULL DEFAULT 0,
  ADD COLUMN last_republished_at timestamptz;

-- One row per reconciler run: what it found and what it changed, for audit and alerting.
CREATE TABLE reconciliation_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  dry_run            boolean     NOT NULL,
  leads_republished  integer     NOT NULL,
  leads_exhausted    integer     NOT NULL,
  cap_rows_repaired  integer     NOT NULL,
  cap_slots_released integer     NOT NULL,
  details            jsonb       NOT NULL DEFAULT '{}'::jsonb
);
