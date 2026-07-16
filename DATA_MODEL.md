# Pilot 2 data model

The production spreadsheet uses one hidden audit table and three visible analysis views.

## `raw_events`

- Append-only source of truth written by the game through Apps Script.
- One row per formal trial plus one `session_end` row per submitted session.
- The tab is hidden and warning-protected. Do not edit it manually.
- `event_id` is the idempotency key used to prevent duplicate appends.

## `participants`

- One row per submitted session, generated from `session_end` rows.
- Contains questionnaire fields, participant-level performance and attention metrics, sequence provenance, and analysis inclusion status.
- Participant IDs beginning with `QA_` are classified as `run_mode=qa` and excluded from analysis.
- The default inclusion rule requires a production run, completed status, 240 formal trials, two completed levels, and vigilance miss rate at or below 0.5.

## `target_observations`

- One row per session and target image (32 rows for a complete session).
- Pairs the target's first and repeat presentations and exposes response, RT, false alarm, hit, miss, and repeat lag fields.
- Inherits `include_in_analysis` and `exclusion_reason` from `participants`.

## `images`

- One row for each of the 32 targets and 164 fillers in `pilot2_balanced_targets_v2`.
- Stores immutable catalog metadata and target VIS type/source fields.
- Target score columns use only included observations.
- Corrected rates use the half-count rule:

  - `HR_corrected = (hits + 0.5) / (hits + misses + 1)`
  - `FAR_corrected = (false_alarms + 0.5) / (false_alarms + correct_rejections + 1)`
  - `d_prime = NORM.S.INV(HR_corrected) - NORM.S.INV(FAR_corrected)`

- A target becomes `ready` at 40 included observations; otherwise it is `awaiting_data` or `collecting`.

## Provenance

New trial, checkpoint, and session-summary metadata includes:

- `run_mode`
- `schema_version = pilot2-event-v2`
- `stimulus_catalog_version = pilot2_balanced_targets_v2`
- `client_build_id = pilot2-normalized-data-v1`
- the existing sequence algorithm, seed, assignment, and per-level sequence hashes

The game writes to `raw_events`. Older cached clients that still request `sheet1` continue to route to the first sheet, which remains `raw_events`.
