# Runbooks

> On-call operational procedures. Each runbook is a single file describing symptoms, diagnosis, and step-by-step remediation for a specific failure mode. Add one whenever a new class of incident is identified. Referenced by [observability.md](../10-architecture/observability.md) alerts.

## Planned runbooks (to author as the system is built)

| Runbook                    | Trigger                                              | Summary                                                                                                                     |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `node-no-show.md`          | Offer accepted but node inactive past SLA            | Reassign via cascade; refund/hold escrow; notify user; log dispute if repeated.                                             |
| `waitpoint-expiry.md`      | Durable run suspended past its deadline              | Inspect run in Trigger.dev UI; re-offer or escalate to ops; never leave a run hanging.                                      |
| `escrow-dispute.md`        | User/node contests proof or payment                  | Freeze transfer; open dispute; review audit trail; resolve (release/partial/refund/reassign).                               |
| `rag-reindex.md`           | Stale source / parse-failure spike / eval regression | Re-crawl source; re-embed; validate; run eval gate before promoting.                                                        |
| `realtime-saturation.md`   | Concurrent connections approach the ~500 ceiling     | Shed load / prioritize; begin WS-gateway migration ([ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)). |
| `llm-cost-runaway.md`      | Per-run or daily LLM cost spikes                     | Identify offending run/prompt via LLM traces; pause/kill; patch prompt/tool loop.                                           |
| `service-role-exposure.md` | Suspected `service_role` leak                        | Rotate key immediately; audit access; review client bundles/env. **Sev-1.**                                                 |
| `stuck-run.md`             | Agent run not progressing                            | Step-level replay in Trigger.dev; check tool errors; resume or cancel with replan diff.                                     |

Format per runbook: **Symptoms → Diagnosis → Remediation → Prevention → Related alerts/ADRs.**
