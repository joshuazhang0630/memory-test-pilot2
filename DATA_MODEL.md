# Pilot 2 data model

The production spreadsheet uses one hidden audit table and three visible analysis views.

## `raw_events`

- Append-only source of truth written by the game through Apps Script.
- One row per formal trial plus one `session_end` row per submitted session.
- Trial rows are checkpoint-uploaded every 20 trials and flushed with `sendBeacon` on page exit, so usable data from unfinished sessions are retained.
- The tab is hidden and warning-protected. Do not edit it manually.
- `event_id` is the idempotency key used to prevent duplicate appends.

## `participants`

- One row per submitted session, generated from `session_end` rows.
- Contains questionnaire fields, participant-level performance and attention metrics, sequence provenance, and analysis inclusion status.
- Participant IDs beginning with `QA_` are classified as `run_mode=qa` and excluded from analysis.
- QA runs and sessions explicitly failed by the quality gate are excluded. Production sessions with any recorded formal trials remain eligible even when they stop before 240 trials or two completed levels.

## `target_observations`

- One row per session and target image (32 rows for a complete session).
- Pairs the target's first and repeat presentations and exposes response, RT, false alarm, hit, miss, and repeat lag fields.
- Eligibility is trial-aware: production target observations are retained without requiring a `session_end` row, while QA runs and sessions explicitly failed by the quality gate are excluded.

## `images`

- One row for each of the 32 targets and 164 fillers in `pilot2_balanced_targets_v2`.
- Stores immutable catalog metadata and target VIS type/source fields.
- Target score columns use only eligible production observations.
- The primary score follows Borkin et al. (2013) exactly:

  - `HR = hits / (hits + misses)` on target repeats.
  - `FAR = false_alarms / (false_alarms + correct_rejections)` on target first presentations.
  - `d_prime = NORM.S.INV(HR) - NORM.S.INV(FAR)`.

- `repeat_n` and `first_n` keep the two denominators explicit. `d_prime` remains blank when either rate is exactly 0 or 1 because the paper's raw inverse-normal formula is not finite at those boundaries.

- A target becomes `ready` at 40 included observations in both denominators and a finite raw d-prime; otherwise it is `awaiting_data`, `collecting`, or `boundary_rate`.

## Provenance

New trial, checkpoint, and session-summary metadata includes:

- `run_mode`
- `schema_version = pilot2-event-v2`
- `stimulus_catalog_version = pilot2_balanced_targets_v2`
- `client_build_id = pilot2-remote-checkpoint-v4`
- the existing sequence algorithm, seed, assignment, and per-level sequence hashes

The game writes to `raw_events`. Older cached clients that still request `sheet1` continue to route to the first sheet, which remains `raw_events`.
