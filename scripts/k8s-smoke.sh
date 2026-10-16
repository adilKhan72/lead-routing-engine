#!/usr/bin/env bash
# End-to-end check of the demo overlay on a real cluster (CI uses kind):
# deploy → wait for rollouts → seed buyers → POST a lead through the ingest Service → it must be sold.
set -euo pipefail
NS=lre-demo
OVERLAY=${OVERLAY:-deploy/k8s/overlays/demo}

kubectl apply -k "$OVERLAY"
kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s
for d in redis mock-buyer ingest router; do kubectl -n "$NS" rollout status "deployment/$d" --timeout=240s; done

kubectl -n "$NS" exec -i statefulset/postgres -- psql -v ON_ERROR_STOP=1 -U lre lre < db/seed/demo-buyers.sql

kubectl -n "$NS" port-forward service/ingest 8080:80 >/tmp/port-forward.log 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:8080/readyz >/dev/null && break; sleep 1; done

body='{"product":"personal_loan","state":"TX","zip":"73301","amountCents":1500000,"creditBand":"good",
  "contact":{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","phone":"+15555550123"},
  "consent":{"tcpa":true,"capturedAt":"2026-10-15T09:30:00Z"},"source":{"publisherId":"pub-smoke"}}'
lead=$(curl -sf -X POST http://127.0.0.1:8080/v1/leads -H 'content-type: application/json' \
  -H "idempotency-key: smoke-$(date +%s)" -d "$body")
id=$(echo "$lead" | sed -E 's/.*"leadId":"([^"]+)".*/\1/')
echo "accepted lead $id"

for _ in $(seq 1 60); do
  status=$(curl -sf "http://127.0.0.1:8080/v1/leads/$id" | sed -E 's/.*"status":"([a-z]+)".*/\1/')
  case "$status" in
    sold) echo "lead $id sold"; exit 0 ;;
    unsold|failed) echo "lead $id ended as $status"; exit 1 ;;
  esac
  sleep 2
done
echo "lead $id still '$status' after 120s"; kubectl -n "$NS" logs deployment/router --tail=50; exit 1
