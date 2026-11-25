# Browser Test/Tune Commands

## Quick Setup Helpers

- Ensure images are loaded before starting a level:
  - `await ensureImagesLoaded()`

- If you see a device warning screen, call:
  - `deviceCompatible = true;`

## Skip/Jump Commands

- Skip pre-survey (demographics) and go straight to instructions:
  - `showInstructions()`

- Skip instructions and go straight to pretrain (practice):
  - `startPretrain()`

- Skip pretrain and go straight to the real experiment:
  - `startRealExperiment()`

- Skip the first level and start the second level:
  - `await ensureImagesLoaded()`
  - `completedLevels = [availableLevels[0]];`
  - `startLevel(availableLevels[1]);`

- Jump directly to the post-study questionnaire:
  - `showPostSurvey()`

## Fast-Run Dev Mode 
Use this to simulate the full flow with very short sequences.

For a browser-driven local run, open `http://localhost:8765/?qa_fast=1`. The flag is ignored on non-local hosts.

1. Enable fast mode and set counts:
   - `devFastMode = true;`
   - `devPretrainUniqueCount = 2;`
   - `devPretrainTotalCount = 4;`
   - `devLevelTrialCount = 4;` // 4 trials per level (2 images + fixations)

2. Run the normal flow:
   - Start from splash and proceed normally, or:
   - `showInstructions()` -> `startPretrain()` -> `startRealExperiment()`

3. Disable when done:
   - `devFastMode = false;`

## One-Command Fast Flow

- `runFastFlow()`  
  Sets fast mode and shows the instruction screen so you can click through practice and the real experiment quickly.

## Backend Sheet Smoke Test

- From a terminal in the repo:
  - `bash scripts/check_sheet_write.sh`

This posts one smoke row through the same Apps Script backend used by the game, then reads the Google Sheet back with `gog` and prints `backend_sheet_write_ok tag=...` only if the tag is found. If `gog` reports `invalid_grant`, refresh auth first with `gog login jiayuez720081@gmail.com`.

## Post-questionnaire Sheet Round-trip Test

- Run `node scripts/check_post_questionnaire_write.js`.

This posts one `QA_POST_...` session summary through the production Apps Script endpoint, reads the appended `raw_events` row back through Google Sheets, and verifies all eight post-questionnaire fields plus the structured `client_meta_json.post_raw` object. The QA participant prefix keeps the test record excluded from analysis.

## Data Pipeline Regression Test

- Run `node scripts/check_data_pipeline.js`.

This verifies cross-level sequence separators and event IDs, unique-image preload/decode behavior, 15-second preload failure handling, double-buffered frame activation, 1,000 ms image and 1,400 ms fixation deadlines, transition/fixation response attribution, held-key and duplicate-response suppression, Borkin practice-rate boundaries, response time and repeat-lag capture, target-only hit/miss post-questionnaire sampling across levels, the four required post-questionnaire text responses and selected image IDs, 25-row chunking into the hidden `raw_events` audit tab with verified Apps Script JSON acknowledgements, remote checkpoint uploads for unfinished sessions, page-exit beacon payloads, retained local checkpoints after failed uploads, and a single post-survey submit handler.

## Session Sequence Constraint Test

- Run `node scripts/check_constraints.js`.

This builds 200 synthetic QA sessions and replays each seed. It verifies the local QA sampler, catalog, proportional stratum quotas, and disjoint practice and formal assignments across all five levels. Use the balanced-slot test for the production target path.

All roles draw without replacement from the shared catalog. Practice reserves 17 images for the session and reshuffles their presentation order on retries. Those images are excluded from all five formal levels.

## Balanced Target Slots

Run the following from the repository with Node.js 22+ and Python 3.

```sh
node scripts/check_balanced_targets.js
node scripts/build_target_plan.js --output target_slots.csv
```

The first command exercises the browser allocation code and Apps Script handler with a spreadsheet mock. It verifies lock contention and retry, target coverage for every prefix of 900 slots, chart-type and level quotas, practice and formal disjointness, and all 4,500 production-length sequences. It also compares simulated hit counts to independent per-session sampling and checks scoring and coverage-based top-ups with synthetic data.

### Set up a study

1. Import the generated CSV into a tab named `target_slots` in the results workbook. Keep the headers, slot order, and blank `participant_key` column. Keep this workbook private. The default plan contains five ordered blocks of 45 slots. Every 45 assigned slots give each image two planned target pairs. Every 225 assigned slots give each image two planned target pairs per level. Use `--waves 4` if you want to generate all 900 slots in one file.
2. Publish the updated `apps-script/Code.gs` to the web app used by `sheetAppsUrl`. The allocator defaults to the workbook already used by the game. Set the Apps Script project property `PILOT2_SLOT_WORKBOOK` to point at a different control workbook, for example for a staging deployment.
3. Provision raw log storage for the planned scale before publishing the frontend. Four waves generate about 22.7 million raw-event cells with 601 rows and 42 columns per completed session. To route waves to separate spreadsheets, create a `raw_events` tab in each destination and set the `PILOT2_RAW_WORKBOOKS` Apps Script property to a JSON map such as `{"W01":"id1","W02":"id2","W03":"id3","W04":"id4"}`. Give the web app owner edit access. Add mappings for future waves and top-ups before issuing those slots. Keep an issued batch on its existing workbook so retries resolve to the same source. Without the property, the backend uses the existing workbook, which is suitable only for a smaller pilot within its available grid capacity.
4. Publish the frontend from the same build. On a staging URL, verify two distinct non-QA IDs get distinct slots and retry one ID to verify it receives the same slot. Production IDs must be unique across participants. `QA_` IDs and local `qa_fast` use the QA sampler. A full or unavailable slot table causes a recoverable message at practice start.

### Calculate scores and add slots

Download the `raw_events` tab from each assigned workbook as a CSV. The offline scorer streams the files and keeps one formal session per slot, using the earliest recorded session. It excludes QA, old study versions, failed sessions, and targets with a missing first or repeat event. The score and coverage files support scoring across multiple workbooks.

```sh
python3 scripts/summarize_balanced_results.py wave1.csv wave2.csv --coverage coverage.json --scores scores.csv
node scripts/build_target_plan.js --coverage coverage.json --slots 45 --start 1 --output target_top_up.csv
```

Append the top-up CSV's **data rows only** to `target_slots` in their generated order. The allocator issues available rows from top to bottom, so provision waves as needed when you want to measure gaps between waves. Top-up IDs are prefixed with `T`, so use a fresh `--start` value for each top-up and include that batch in the raw workbook mapping if configured. The generator prioritizes images with fewer valid paired observations within chart-type quotas and uses per-level counts to break ties. To provision additional full waves, use `--waves` and the next unused `--start` wave number. Leave issued rows and participant bindings intact.

## Notes

- `startRealExperiment()` resets counters and then starts the next available level. A production slot is acquired at practice start. Use a `QA_` ID for direct console jumps.
- `startLevel(levelKey)` assumes images are loaded; use `await ensureImagesLoaded()` first.
- `showPostSurvey()` works best after at least one trial; if you want to force it immediately, you can also set:
  - `endingStatus = "completed"; showPostSurvey();`

## Useful Globals

- `availableLevels` — array of level IDs
- `completedLevels` — array of completed level IDs
- `currentLevelKey` — the current level ID
- `inPretrainMode` — whether the practice block is active
