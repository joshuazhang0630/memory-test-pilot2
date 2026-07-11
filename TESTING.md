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

## Data Pipeline Regression Test

- Run `node scripts/check_data_pipeline.js`.

This verifies cross-level sequence separators and event IDs, fixation-grace response attribution, response time and repeat-lag capture, 25-row chunking with verified Apps Script JSON acknowledgements, retained checkpoints after failed uploads, and a single post-survey submit handler.

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
