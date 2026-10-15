-- Demo buyers for local runs. Not a migration: never applied automatically.
INSERT INTO buyers (name, price_cents, weight, criteria, schedule, timezone, hourly_cap, daily_cap) VALUES
  ('Premium Lender',   4500, 1, '{"products":["personal_loan"],"creditBands":["excellent","good"],"minAmountCents":500000}', NULL, 'America/New_York', 50, 200),
  ('Texas Credit Co',  3000, 3, '{"products":["personal_loan"],"states":["TX","OK","LA"]}', NULL, 'America/Chicago', NULL, 500),
  ('Sunbelt Loans',    3000, 1, '{"products":["personal_loan"],"states":["TX","FL","GA","AZ"]}', NULL, 'America/Phoenix', 100, NULL),
  ('Any Loan Network', 1200, 1, '{"products":["personal_loan"]}', NULL, 'UTC', NULL, NULL),
  ('West Coast Auto',  2200, 1, '{"products":["auto_insurance"],"states":["CA","OR","WA"]}', '{"days":[1,2,3,4,5],"startHour":8,"endHour":20}', 'America/Los_Angeles', 20, 100),
  ('Auto Catch-All',    800, 1, '{"products":["auto_insurance"]}', NULL, 'UTC', NULL, NULL);
