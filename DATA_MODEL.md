# Pilot 2 data model

The balanced study uses the `target_slots` allocation table and one or more `raw_events` audit tables. The existing analysis views document earlier builds. Use the offline scorer to aggregate balanced-study data across the raw event workbooks.

## `target_slots`

- One row per pre-generated slot, with `slot_id`, `plan_version`, `catalog_version`, `targets_json`, and `participant_key`.
- `targets_json` holds the five arrays of 16 target filenames. The order of the rows determines allocation order.
- The Apps Script backend binds one available row to the participant ID before practice, under a script lock. A retry for the same ID returns its existing row.
- Treat this table as private. Append new slots below the existing rows and leave participant bindings intact.

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
- QA runs and sessions explicitly failed by the quality gate are excluded. Production sessions may contribute completed target pairs even if they stop before completing all five levels.

## `participant_sequences`

- Visible, formula-generated reading view of `raw_events`; it does not duplicate or alter the source data.
- One row per displayed image, ordered by participant, session, level, and image position.
- Shows only the fields needed to inspect a sequence: participant/session IDs, level, image position, image ID, trial type, response, and RT.
- Includes the recorded portion of unfinished sessions automatically as checkpoint rows arrive.

## `target_observations`

- One row per session and target image (80 for a complete balanced-study session).
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

Earlier `pilot2-post-questionnaire-v5` trial, checkpoint, and session-summary metadata includes:

- `run_mode`
- `schema_version = pilot2-event-v3`
- `stimulus_catalog_version = pilot2_balanced_targets_v2`
- `client_build_id = pilot2-post-questionnaire-v5`
- the existing sequence algorithm, seed, assignment, and per-level sequence hashes

For the balanced-slot build, `study_version`, `client_build_id`, and `plan_version` are `pilot2-balanced-slots-v1` and `stimulus_catalog_version` is `pilot2_shared_targets_1800_v1`. Trial, checkpoint, and session summary metadata include `slot_id` and `plan_version`.

For `pilot2-event-v3` session summaries, post-questionnaire fields are:

- `post_q1`: description of a correctly recognized target repeat
- `post_q2`: features believed to have helped recognition
- `post_q3`: description of a missed target repeat
- `post_q4`: features believed to have made recognition difficult
- `post_q5`: selected hit image ID
- `post_q6`: selected miss image ID
- `post_q7`: optional study comments
- `post_q8`: questionnaire version (`target-hit-miss-v1`)

The full structured questionnaire response, including selected image URLs, remains available in `client_meta_json.post_raw`. Earlier schema versions retain their original `post_q1`–`post_q3` meanings.

## Balanced-study scoring

Run `scripts/summarize_balanced_results.py` on the `raw_events` CSV exports. It keeps the first recorded formal session per slot, then scores target images that have both presentation records in a retained session. It outputs per-image paired counts, hits, false alarms, HR and FAR with Wilson intervals, and log-linear corrected d-prime. The separate coverage JSON retains counts by level for additional target assignment. See [TESTING.md](TESTING.md) for commands.
