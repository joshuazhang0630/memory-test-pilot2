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

This builds 200 synthetic sessions and replays each seed. It verifies the 1,800-image catalog, proportional stratum quotas, and disjoint practice and formal assignments across all five levels (490 unique formal images plus 17 practice images). Each level still has 16 targets, 6 vigilance images, 76 single fillers, 120 presentations, target lag 91–109, and vigilance lag 1–7.

All roles draw without replacement from the shared catalog. Practice reserves 17 images for the session and reshuffles their presentation order on retries. Those images are excluded from all five formal levels.

## Notes

- `startRealExperiment()` resets counters and then starts the next available level.
- `startLevel(levelKey)` assumes images are loaded; use `await ensureImagesLoaded()` first.
- `showPostSurvey()` works best after at least one trial; if you want to force it immediately, you can also set:
  - `endingStatus = "completed"; showPostSurvey();`

## Useful Globals

- `availableLevels` — array of level IDs
- `completedLevels` — array of completed level IDs
- `currentLevelKey` — the current level ID
- `inPretrainMode` — whether the practice block is active
