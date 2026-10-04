# JOHNNY Architecture v2.1

JOHNNY is one operator with three separated modes on the same audit and tool facade.

## Modes

- STYLE JOHNNY: customer hair consultation. It uses only `customer_johnny_style_catalog`: style id, title, image and tags of the published GINJIRO Style Library / TryOn styles, plus the booking menu **only when a confirmed style → service link exists** (`johnny_style_service_links`). It never states price, duration or availability.
- BOOKING JOHNNY: customer booking consultation. Menu, price, duration, staff and availability come only from `customer_johnny_booking_options` / `customer_johnny_available_slots`, which wrap the existing booking RPCs (service master). A style handed over from STYLE / TryOn resolves to a booking menu only through a confirmed link; otherwise the menu is "unconfirmed" and JOHNNY does not fill it in or guess it.
- HQ JOHNNY: HQ decision support. It requires an HQ session and uses aggregate facts from `hq_johnny_snapshot`.

## Common Rules

- Facts = DB/RPC. Calculation = deterministic logic. Judgment and wording = operator provider. Write execution = human approval.
- Generic SQL tools are forbidden. The tool facade is mode-specific RPC only, with a per-mode whitelist.
- Authentication is checked in the DB (customer session / HQ session) **before anything is written to the audit tables**.
- STYLE is not a second source of truth. Price, duration and availability belong to the service master / booking RPCs.
- Customer-facing v1 requires an App/customer session. Guest mode is out of scope.
- Customer notes and other free-text notes are not sent by default.

## Enablement (two independent switches, both off by default)

- Server: Edge Function env `JOHNNY_ENABLED=true`. Anything else returns `johnny_disabled` before any RPC.
- UI: build env `VITE_JOHNNY_ENABLED=true`. Otherwise the STYLE / BOOKING panels, the TryOn 「JOHNNYに予約相談」 button and the HQ JOHNNY tab are not rendered (removed from the bundle).
- Production keeps both unset. The existing HOT PEPPER booking path (TryOn 「このスタイルで予約」, 予約 screen links) is never replaced by JOHNNY, whether JOHNNY is on or off.

## CURRENT IMPLEMENTATION (DB facts as of 20261008000000)

JOHNNY does not describe or decide the arrival / visit flow in Phase 1. The current DB behaviour is:

- Reservations move `confirmed → checked_in → in_service → awaiting_payment → completed` through the store / HQ RPCs; checkout (`finalize_sale`) completes the reservation.
- The 14-day maintenance date (`maintenance_visits.last_visit_date`) is updated by `app_private.touch_visit`, which is called from QR check-in (`staff_check_in`), maintenance coupon redemption, and checkout (`finalize_sale`) for App members.
- There is no `room_id` in the schema.

## TARGET ARRIVAL / VISIT FLOW (not implemented; separate phase and migration)

`reservation → in-store QR → same-day reservation match → room_id verification → check-in → GINPay payment → service → treatment completed → 14-day maintenance starts`

In the target, maintenance start, reservation completion and visit confirmation use only the DB timestamp of the treatment-completed event, and QR read / check-in / GINPay payment / accounting completion do not start maintenance. JOHNNY must not decide identity verification, reservation matching, payment execution, idempotency, `room_id`, visit completion or maintenance start. Changing the core flow to this target requires its own design, migration and tests; JOHNNY must not present the target as current fact.

## Audit

Every request records, after authentication and fact retrieval:

- `request_id`, `correlation_id` (a reused `request_id` with a different mode / actor is rejected)
- `source_fact_at`: the time the facts were actually read (HQ: the DB time of the snapshot)
- `source_fact_version`: a content hash of the facts used (`sha256:…`; the HQ snapshot hashes its own facts), so the same facts give the same version
- mode and actor type, tool calls (arguments with tokens redacted, result summary, per-call fact time and hash), user/HQ message and operator response

### Action intents

`johnny_action_intents` records proposed write intents and handoffs with `idempotency_key`, `expires_at`, `approved_by`, `approved_at`, `approved_fact_version`, `executed_at`, `execution_result`, `rejected_reason`. Enforced in the DB (`johnny_create_action_intent`, `johnny_transition_action_intent`, service_role only):

- Expiry must be in the future and within 7 days; an expired intent cannot be approved or executed (it becomes `expired`).
- `proposed → approved` needs an approver and the fact version seen at approval. `proposed → executed` is impossible.
- Execution requires `approved`, and the facts re-read just before execution must have the same version as at approval; otherwise the intent returns to `proposed` and needs re-approval.
- Re-sending the same `idempotency_key` with a different session / mode / type / payload is an error (`idempotency_conflict`).

Phase 1 creates intents (TryOn handoff) but does not execute business writes.

### Retention and PII

- Customer and HQ messages are stored as entered (max 12,000 characters) for audit and incident review. They are readable only by service_role; `hq_johnny_audit` (HQ session) returns session metadata and counts, not message text. anon / authenticated cannot read them.
- Do not ask for or send phone numbers, addresses, payment details or customer notes. Tool arguments are stored with session / HQ tokens redacted.
- Retention target: messages and tool calls are deleted after 180 days (sessions and intents kept as metadata). The deletion job belongs to the provider-enablement phase and must exist before `JOHNNY_ENABLED=true` on Production.
- Before any external provider (e.g. OpenAI) is enabled: PII minimization review, provider data-retention terms, and HQ snapshot fields limited to aggregates (the snapshot already omits per-account GINPay details).

## Phase 1 Scope

- Audit tables and lockdown; style catalog and confirmed style → service links.
- STYLE / BOOKING / HQ tool facade RPCs.
- Local deterministic provider path for Staging-safe verification.
- Edge Function guarded by `JOHNNY_ENABLED`; UI guarded by `VITE_JOHNNY_ENABLED`.
- Customer STYLE and BOOKING panels, HQ JOHNNY panel, STYLE → TryOn → BOOKING handoff (style only).
- Preflight: `supabase/tests/preflight_johnny.sql` (DB) and `scripts/johnny-regression.mjs` (Edge handler and UI flag).

## Later Phases

- Explicitly approved OpenAI provider adapter with PII minimization review and the retention job.
- Human approval UI for action intents.
- Actual approved write execution through existing business RPCs only, with fact re-validation.
- Richer HQ analysis after aggregate fact contracts stabilize.
- TARGET arrival / visit flow (separate migration).
