-- Demo buyers for local runs. Not a migration: never applied automatically.
-- Endpoints point at the mock-buyer service; the path picks its behaviour profile
-- (fast, picky, flaky, slow, never: services/mock-buyer/src/profiles.ts).
INSERT INTO buyers (name, price_cents, weight, criteria, schedule, timezone, hourly_cap, daily_cap, endpoint_url) VALUES
  ('Premium Lender',   4500, 1, '{"products":["personal_loan"],"creditBands":["excellent","good"],"minAmountCents":500000}', NULL, 'America/New_York', 50, 200, 'http://mock-buyer:4000/fast'),
  ('Texas Credit Co',  3000, 3, '{"products":["personal_loan"],"states":["TX","OK","LA"]}', NULL, 'America/Chicago', NULL, 500, 'http://mock-buyer:4000/flaky'),
  ('Sunbelt Loans',    3000, 1, '{"products":["personal_loan"],"states":["TX","FL","GA","AZ"]}', NULL, 'America/Phoenix', 100, NULL, 'http://mock-buyer:4000/slow'),
  ('Any Loan Network', 1200, 1, '{"products":["personal_loan"]}', NULL, 'UTC', NULL, NULL, 'http://mock-buyer:4000/fast'),
  ('West Coast Auto',  2200, 1, '{"products":["auto_insurance"],"states":["CA","OR","WA"]}', '{"days":[1,2,3,4,5],"startHour":8,"endHour":20}', 'America/Los_Angeles', 20, 100, 'http://mock-buyer:4000/picky'),
  ('Auto Catch-All',    800, 1, '{"products":["auto_insurance"]}', NULL, 'UTC', NULL, NULL, 'http://mock-buyer:4000/fast');
