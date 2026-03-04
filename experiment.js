function selectPretrainImages() {
    var pool = pretestImages.slice();
    shuffleArray(pool);
    return pool.slice(0, Math.min(15, pool.length));
}

// Build pretrain sequence with repeats
function buildPretrainSequence() {
    pretrainImages = selectPretrainImages();

    if (devFastMode) {
        pretrainImages = pretrainImages.slice(0, Math.max(1, devPretrainUniqueCount));
        pretrainSequence = pretrainImages.slice(0, Math.max(1, devPretrainTotalCount));
        pretrainTypeSequence = pretrainSequence.map(function(){ return TARGET; });
        pretrainPerfSequence = pretrainSequence.map(function(){ return CORRECTREJECTION; });
        console.log("Pretrain sequence built (dev):", pretrainSequence.length, "images");
        return;
    }
    
    // Shuffle the pretrain images
    pretrainImages = shuffleArray(pretrainImages);
    
    // Build sequence with 3 repeats at intervals of 5-10 images
    var sequence = [];
    var types = [];
    var perf = [];
    
    var repeatIndices = [1, 5, 9]; // Which images to repeat
    var repeatPositions = [6, 14, 19]; // Where to place repeats (after 5, 8, 10 images)
    
    var imgCounter = 0;
    var seqPos = 0;
    
    for (var i = 0; i < 21; i++) { // 15 unique + 3 repeats + some extras = 21 total
        if (repeatPositions.indexOf(i) !== -1) {
            // This is a repeat position
            var whichRepeat = repeatPositions.indexOf(i);
            var imgToRepeat = pretrainImages[repeatIndices[whichRepeat]];
            sequence.push(imgToRepeat);
            types.push(REPEAT);
            perf.push(MISS); // Default: they'll miss it
        } else if (imgCounter < pretrainImages.length) {
            // Regular image
            sequence.push(pretrainImages[imgCounter]);
            types.push(TARGET);
            perf.push(CORRECTREJECTION); // Default: correct rejection
            imgCounter++;
        }
    }
    
    pretrainSequence = sequence;
    pretrainTypeSequence = types;
    pretrainPerfSequence = perf;
    
    console.log("Pretrain sequence built:", pretrainSequence.length, "images");
}


function showInstructions() {
    var content = `
        <section class="card">
            <p class="lead-text">
                During this study you will evaluate visualizations and indicate when an image repeats <strong>within the current block</strong>.
            </p>
            <div class="instruction-visual">
                <img src="instruction.png" alt="Study workflow diagram">
            </div>
            <p class="lead-text">
                Workflow overview: in Phase 1, mark as many repeated images as you can. In Phase 2, you will evaluate the images you saw in the sequence(s).
            </p>
            <ol class="instruction-list">
                <li><strong>Attend carefully.</strong> Each visualization appears for 1 second followed by a fixation interval.</li>
                <li><strong>Respond only to repeats.</strong> Press the <strong>SPACE BAR</strong> as soon as you recognize a repeated image in the active block.</li>
                <li><strong>Remain focused.</strong> Repeats may occur long after first exposure and can closely resemble other images.</li>
            </ol>
            <p class="lead-text">
                Performance monitoring: the system tracks <strong>false alarms</strong> (responding to new images) and <strong>vigilance misses</strong>
                (missing scheduled repeats). The session ends if you exceed ${facutoff} false alarms or ${vigilancecutoff} vigilance misses.
            </p>
            <p class="lead-text">
                We begin with a short practice block to ensure the procedure is clear. Practice data are not stored, and all responses
                in both practice and the primary experiment must be made with the <strong>SPACE BAR</strong>.
            </p>
            <div class="action-row">
                <button class="primary-button" onclick="startPretrain()">Begin Practice Block</button>
            </div>
        </section>
    `;
    document.body.innerHTML = renderShell(content);
}

// Dev helper: run a minimal end-to-end flow quickly
function runFastFlow() {
	devFastMode = true;
	devPretrainUniqueCount = 1;
	devPretrainTotalCount = 1;
	devLevelTrialCount = 4;
	showInstructions();
}

// Start pretrain
function startPretrain() {
	inPretrainMode = true;
	pretrainImCount = -1;
	
    // Reset counters
	pretrainHits = 0;
	pretrainMisses = 0;
	pretrainFalseAlarms = 0;
	pretrainCorrectRejections = 0;
	
	var practiceView = `
		<section class="card">
			<h1 class="section-title">Practice Block</h1>
			<p class="lead-text">
				During practice, respond only when a visualization repeats within this practice block. Use the <strong>SPACE BAR</strong> to register detections.
			</p>
			<div class="stimulus-panel">
				<div id="performancerecord" class="instruction-callout">
					Press SPACE to begin the practice sequence.
				</div>
				<div class="stimulus-frame">
					<img id="stimulus" src="${fixation_address}" alt="Practice stimulus">
				</div>
			</div>
			<p class="muted-text">Keyboard input required: SPACE BAR only.</p>
		</section>
	`;
	document.body.innerHTML = renderShell(practiceView);
}

// Animate pretrain sequence
function animatePretrainSequence() {
    pretrainImCount++;
    
    if (pretrainImCount >= pretrainSequence.length * 2) { // *2 because we have fixations
        // Pretrain finished
        showPretrainResults();
        return;
    }
    
    // Determine if it's an image or fixation
    var isImage = (pretrainImCount % 2 === 0);
    
    if (isImage) {
        var imgIndex = Math.floor(pretrainImCount / 2);
        document.getElementById("stimulus").src = pretrainSequence[imgIndex];
        setTimeout("animatePretrainSequence()", stimtime);
    } else {
        document.getElementById("stimulus").src = fixation_address;
        setTimeout("animatePretrainSequence()", isi);
    }
}

// Show feedback for pretrain
function showPretrainFeedback(type) {
	var feedback = document.createElement('div');
	feedback.className = 'feedback-overlay feedback-' + type;
	
	var icon = '';
	var message = '';
	if (type === 'correct') {
		icon = '✓';
		message = 'Repeat detected';
	} else if (type === 'miss') {
		icon = '✗';
		message = 'Repeat missed';
	} else if (type === 'false-alarm') {
		icon = '⚠';
		message = 'False alarm on novel image';
	}
	feedback.innerHTML = `<span class="feedback-icon">${icon}</span><span>${message}</span>`;
	
    var practicePanel = document.querySelector('.stimulus-panel');
    if (inPretrainMode && practicePanel){
        feedback.classList.add('practice-feedback');
        practicePanel.appendChild(feedback);
    } else {
        document.body.appendChild(feedback);
    }
	
    setTimeout(function() {
        if (feedback.parentNode){
            feedback.parentNode.removeChild(feedback);
        }
    }, 1000);
}

// Process pretrain response
function processPretrainResponse() {
    if (pretrainImCount < 0) {
        // Start the pretrain
        document.getElementById("performancerecord").innerHTML = "";
        animatePretrainSequence();
        return;
    }
    
    var isImage = (pretrainImCount % 2 === 0);
    if (!isImage && pretrainImCount > 0) {
        // They pressed during fixation, check previous image
        var imgIndex = Math.floor((pretrainImCount - 1) / 2);
        var trialType = pretrainTypeSequence[imgIndex];
        
        if (trialType === REPEAT) {
            // Hit!
            pretrainPerfSequence[imgIndex] = HIT;
            pretrainHits++;
            showPretrainFeedback('correct');
        } else {
            // False alarm
            pretrainPerfSequence[imgIndex] = FALSEALARM;
            pretrainFalseAlarms++;
            showPretrainFeedback('false-alarm');
        }
    } else if (isImage) {
        var imgIndex = Math.floor(pretrainImCount / 2);
        var trialType = pretrainTypeSequence[imgIndex];
        
        if (trialType === REPEAT) {
            // Hit!
            pretrainPerfSequence[imgIndex] = HIT;
            pretrainHits++;
            showPretrainFeedback('correct');
        } else {
            // False alarm
            pretrainPerfSequence[imgIndex] = FALSEALARM;
            pretrainFalseAlarms++;
            showPretrainFeedback('false-alarm');
        }
    }
}

// Show pretrain results
function showPretrainResults() {
	// Count misses and correct rejections
	for (var i = 0; i < pretrainPerfSequence.length; i++) {
        if (pretrainPerfSequence[i] === MISS) {
            pretrainMisses++;
        } else if (pretrainPerfSequence[i] === CORRECTREJECTION) {
            pretrainCorrectRejections++;
        }
    }
    
    var totalRepeats = pretrainTypeSequence.filter(function(t){ return t === REPEAT; }).length || 1;
    var accuracy = Math.round((pretrainHits / totalRepeats) * 100);
    var passedPractice = (pretrainHits >= pretrainRequiredHits) && (pretrainFalseAlarms <= pretrainMaxFalseAlarms);
    if (passedPractice){
        pretrainFailCount = 0;
    } else {
        pretrainFailCount++;
        if (pretrainFailCount >= pretrainMaxAttempts){
            inPretrainMode = false;
            endingStatus = "practice_failed";
            experimentCompleted = true;
            var failView = `
                <section class="card">
                    ${failuretext}
                    <p class="lead-text">
                        You did not pass the practice block after ${pretrainMaxAttempts} attempts. The test is now over.
                    </p>
                </section>
            `;
            document.body.innerHTML = renderShell(failView);
            return;
        }
    }
    
	var summaryView = `
		<section class="card">
			<h1 class="section-title">Practice Summary</h1>
			<p class="lead-text">
				The calibration block is complete. Review your performance below before advancing to the primary session.
			</p>
			<div class="stats-grid">
				<div class="stat-item">
					<div class="stat-label">Repeats Detected</div>
					<div class="stat-value">${pretrainHits} / ${totalRepeats}</div>
				</div>
				<div class="stat-item">
					<div class="stat-label">Accuracy</div>
					<div class="stat-value">${accuracy}%</div>
				</div>
				<div class="stat-item">
					<div class="stat-label">False Alarms</div>
					<div class="stat-value">${pretrainFalseAlarms}</div>
				</div>
			</div>
			<p class="lead-text">
				Respond only when the visualization is identical to one seen earlier within the <strong>current sequence</strong>, and continue using the <strong>SPACE BAR</strong> for every response.
				After you continue, all practice images are removed and do not influence the primary experiment.
			</p>
            ${passedPractice ? `
			<div class="action-row">
				<button class="primary-button" onclick="startRealExperiment()">Continue to Experiment</button>
			</div>
            ` : `
            <p class="lead-text" style="color: var(--error);">
                Practice needs more accuracy before advancing. Please detect at least ${pretrainRequiredHits} repeat${pretrainRequiredHits === 1 ? "" : "s"} and make no more than ${pretrainMaxFalseAlarms} false alarm${pretrainMaxFalseAlarms === 1 ? "" : "s"}.
            </p>
            <div class="action-row">
                <button class="primary-button" onclick="buildPretrainSequence(); startPretrain();">Repeat Practice Block</button>
            </div>
            `}
		</section>
	`;
	document.body.innerHTML = renderShell(summaryView);
}


function getNextLevelKey(){
	for (var i = 0; i < availableLevels.length; i++){
		if (completedLevels.indexOf(availableLevels[i]) === -1){
			return availableLevels[i];
		}
	}
	return "";
}

function renderExperimentInterface(levelKey){
	var levelLabel = levelKey ? ("Level " + levelKey) : "Level";
	var interfaceView = `
		<form id="form" class="card" autocomplete="off">
			<input type="hidden" name="imseq" id="imseqout" value="">
			<input type="hidden" name="imtypeseq" id="imtypeseqout" value="">
			<input type="hidden" name="perfseq" id="perfseqout" value="">
			<input type="hidden" name="ending" id="endingout" value="">

			<h1 class="section-title">Visual Memorability Assessment • ${levelLabel}</h1>
			<p class="lead-text">
				Press the <strong>SPACE BAR</strong> whenever you detect an exact repeat of a visualization in this <strong>current sequence</strong>.
				Images do not repeat between sequences. Images from the practice block have been removed and will not appear here. Avoid responses during fixation intervals.
			</p>
			<div class="stimulus-panel">
				<div id="performancerecord" class="instruction-callout"></div>
				<div class="stimulus-frame">
					<img id="stimulus" src="${fixation_address}" alt="Stimulus image">
				</div>
			</div>
			<p class="muted-text text-center">Post-sequence questions will appear automatically once the session ends.</p>
		</form>
	`;
	document.body.innerHTML = renderShell(interfaceView);
	
	// Setup form submission
	document.getElementById("form").onsubmit = function(e){
		e.preventDefault();
		if (!postSurveyVisible){
			document.getElementById("performancerecord").innerHTML = "Please finish the experiment; post-sequence questions will appear automatically.";
		}
	};
	
	// Now preload and start the real experiment
	preloadEverything();
	updateExperimentProgress();
}

function startLevel(levelKey){
	setCurrentLevel(levelKey);
	renderExperimentInterface(levelKey);
}

// Start real experiment
function startRealExperiment() {
	inPretrainMode = false;
	stopExperimentTimer();
	experimentStartTimestamp = null;
	completedLevels = [];
	sessionImagesCatalog = [];
	imgstring = "";
	imtypestring = "";
	perfstring = "";
	currentSessionId = (pid || "anon") + "-" + Date.now();
	lastCheckpointTrialCount = 0;
	falsealarmcounts = 0;
	vigilancefails = 0;
	kickedOut = 0;
    stopAfterLevel = "";
    trialEventRows = [];

    try {
        initializeParticipantLevels(pid || "anon");
    } catch (err){
        console.error("Failed to initialize participant levels", err);
        document.body.innerHTML = renderShell("<section class='card'><h1 class='section-title'>Unable to start experiment</h1><p class='lead-text'>Could not initialize participant-specific levels. Please refresh and try again.</p></section>");
        return;
    }

    console.log("Starting real experiment with participant-specific levels.");
	var nextLevel = getNextLevelKey();
	if (!nextLevel){
		document.body.innerHTML = renderShell("<section class='card'><h1 class='section-title'>No levels available</h1><p class='lead-text'>No runtime levels were generated.</p></section>");
		return;
	}
	startLevel(nextLevel);
}
// key press listener
document.onkeydown = function(key){ 
	if (!deviceCompatible){
		return;
	}
    var activeElement = key && key.target ? key.target : document.activeElement;
    if (activeElement){
        var tagName = (activeElement.tagName || "").toLowerCase();
        if (tagName === "input" || tagName === "textarea" || tagName === "select" || activeElement.isContentEditable){
            return;
        }
    }
    if (inPretrainMode) {
        if (isSpaceKey(key)) {
            key.preventDefault();
            processPretrainResponse();
        }
    } else {
        if (isResponseKey(key)){
            key.preventDefault();
            processResponse(key);
        }
    }
};

document.addEventListener('keydown', function(event) {
	if (!deviceCompatible){
		return;
	}
    if (onBreak && event.key && event.key.toLowerCase() === 'c') {
        giveBreak(1);
    }
});

// preload and then start
async function buttonPress(){
	document.getElementById("startbutton").innerHTML = "Experiment Running...";
	document.getElementById("startbutton").disabled = true;
	await ensureImagesLoaded();
	if (!manifestData || !availableLevels.length){
		document.getElementById("performancerecord").innerHTML = "Unable to load images from the manifest. Please refresh and try again.";
		document.getElementById("startbutton").disabled = false;
		return;
	}
	if (!currentLevelKey){
		var nextLevel = getNextLevelKey();
		if (nextLevel){
			setCurrentLevel(nextLevel);
		}
	}
	preloadEverything();
	document.getElementById("performancerecord").innerHTML = "Press the <b>SPACE BAR</b> to start. If it doesn't work, make sure to click in this browser window first.";
}

// recursive function that shows the images in a sequence
function animateSequence(){
	saveProgress();
	
	determineFailure();
	if (kickedOut){
		showFailure();
		return;
	}
	
	if (breakCounter >= trialsBetweenBreaks) {
		giveBreak(0);
		breakCounter = -1;
		return;
	}
	breakCounter++;
	
	imCount++;
	updateExperimentProgress();
	if (imCount == fullsequence.length){
		showEnding();
		return;
	}
	document.getElementById("stimulus").src = fullsequence[imCount];
	
	setTimeout("animateSequence()", timesequence[imCount]);
}

// preload and calculate everything
function resetLevelState(){
	fullsequence = [];
	timesequence = [];
	typesequence = [];
	perfsequence = [];
	imtypeseq = [];
	allimgseq = [];
	performanceseq = [];
	imCount = -1;
	breakCounter = 0;
	onBreak = false;
	experimentStartTimestamp = null;
	totalExperimentDuration = 0;
}

function addToSessionCatalog(list){
	list.forEach(function(url){
		if (sessionImagesCatalog.indexOf(url) === -1){
			sessionImagesCatalog.push(url);
		}
	});
}

function setCurrentLevel(levelKey){
	currentLevelKey = levelKey;
	var level = manifestData.levels[levelKey];
	images = level.targets.concat(level.fillers, level.vigilance);
	allImagesCatalog = images.slice();
	addToSessionCatalog(images);
}

function preloadEverything() {
	resetLevelState();
	if (devFastMode){
		levelTrialCount = Math.max(2, devLevelTrialCount);
	}
	calculateProps();
	makeImSequence();
	calculateTotalPay();
	buildFullSequence();
}

// allows the participant to take a break
function giveBreak(going){
	if (going){
		onBreak = false;
		if (breakCountdownInterval){
			clearInterval(breakCountdownInterval);
			breakCountdownInterval = null;
		}
		if (breakResumeTimeout){
			clearTimeout(breakResumeTimeout);
			breakResumeTimeout = null;
		}
		document.getElementById("performancerecord").innerHTML = '';
		setTimeout(function(){ animateSequence(); }, timesequence[imCount]);
		return;
	}
	onBreak = true;
	document.getElementById("stimulus").src = fixation_address;
	breakTimeRemaining = maxBreakTime;
	document.getElementById("performancerecord").innerHTML = '<h2>Break time!</h2>Good job - you will now get a break. You have <span id="break-countdown">' + breakTimeRemaining + '</span> seconds remaining before the task resumes automatically. Press "<b>C</b>" to continue sooner.';
	
	if (breakCountdownInterval){
		clearInterval(breakCountdownInterval);
	}
	breakCountdownInterval = setInterval(function(){
		breakTimeRemaining = Math.max(0, breakTimeRemaining - 1);
		var span = document.getElementById("break-countdown");
		if (span){
			span.textContent = breakTimeRemaining;
		}
		if (breakTimeRemaining <= 0){
			clearInterval(breakCountdownInterval);
			breakCountdownInterval = null;
		}
	}, 1000);
	
	if (breakResumeTimeout){
		clearTimeout(breakResumeTimeout);
	}
	breakResumeTimeout = setTimeout(function(){
		giveBreak(1);
	}, maxBreakTime*1000);
}

// builds the full sequence with both images and fixations, as well as timings
function buildFullSequence(){
	var i = 0;
	var imcounter = 0;
	while (i < imtypeseq.length*2){
		fullsequence[i] = allimgseq[imcounter];
		typesequence[i] = imtypeseq[imcounter];
		timesequence[i] = stimtime;
		perfsequence[i] = performanceseq[imcounter];
		i++;
		imcounter++;
		
		fullsequence[i] = fixation_address;
		typesequence[i] = FIXATION;
		timesequence[i] = isi;
		perfsequence[i] = FIXATION;
		i++;
	}
	console.log("Done building the full sequence.");
	totalExperimentDuration = timesequence.reduce(function(total, value){ return total + value; }, 0);
}

function updateExperimentProgress(){
	var bar = document.getElementById("experiment-progress");
	var label = document.getElementById("progress-label");
	if (!bar || fullsequence.length === 0){
		return;
	}
	var completed = 0;
	if (imCount >= fullsequence.length){
		completed = fullsequence.length;
	} else if (imCount >= 0){
		completed = imCount + 1;
	}
	var percent = Math.min(100, (completed / fullsequence.length) * 100);
	bar.style.width = percent + "%";
	bar.setAttribute("aria-valuenow", percent.toFixed(1));
	if (label){
		label.textContent = "Progress " + Math.round(percent) + "%";
	}
	updateTimerDisplay();
}

function formatTimer(ms){
	var totalSeconds = Math.max(0, Math.floor(ms / 1000));
	var minutes = Math.floor(totalSeconds / 60);
	var seconds = totalSeconds % 60;
	return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
}

function updateTimerDisplay(){
	var display = document.getElementById("time-display");
	if (!display){
		return;
	}
	if (!experimentStartTimestamp || totalExperimentDuration === 0){
		display.textContent = "Elapsed 00:00 • remaining --:--";
		return;
	}
	var elapsed = Date.now() - experimentStartTimestamp;
	var remaining = Math.max(0, totalExperimentDuration - elapsed);
	display.textContent = "Elapsed " + formatTimer(elapsed) + " remaining " + formatTimer(remaining);
}

function startExperimentTimer(){
	if (!experimentStartTimestamp){
		experimentStartTimestamp = Date.now();
	}
	if (timerInterval){
		return;
	}
	updateTimerDisplay();
	timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopExperimentTimer(){
	if (timerInterval){
		clearInterval(timerInterval);
		timerInterval = null;
	}
}

function isSpaceKey(event){
	if (!event){
		return false;
	}
	if (event.code && event.code.toLowerCase() === "space"){
		return true;
	}
	if (event.key){
		var keyName = event.key.toLowerCase();
		if (keyName === " " || keyName === "spacebar" || keyName === "space"){
			return true;
		}
	}
	if (event.keyCode){
		return event.keyCode === 32;
	}
	return false;
}

function isResponseKey(event){
	if (keytoWatch === "space"){
		return isSpaceKey(event);
	}
	var pressed = event.key ? event.key.toLowerCase() : String.fromCharCode(event.keyCode).toLowerCase();
	return pressed === keytoWatch.toLowerCase();
}

// get the key and respond
function processResponse(key){
	if(isResponseKey(key)){
		var trialtype = typesequence[imCount];
		if (imCount<0) {
			document.getElementById("performancerecord").innerHTML = "";
			if (!inPretrainMode){
				startExperimentTimer();
			}
			animateSequence();
		}
		if ((trialtype == FIXATION) && imCount > 0) {
			trialtype = typesequence[imCount-1];
		}
		if (trialtype == REPEAT | trialtype == VIGILANCE) {
			perfsequence[imCount] = HIT;
			console.log("Hit!");
		} else if (trialtype == TARGET | trialtype == FILLER) {
			perfsequence[imCount] = FALSEALARM;
			console.log("False alarm!");
		}
	}
}

// decide if they've failed too much
function determineFailure(){
	if (perfsequence[imCount] == FALSEALARM){
		falsealarmcounts++;
		console.log("False alarm count: " + falsealarmcounts);
	}
	if (falsealarmcounts >= facutoff){
		kickedOut = 1;
	}
	
	if (perfsequence[imCount] == MISS & typesequence[imCount] == VIGILANCE){
		vigilancefails++;
		console.log("Vigilance miss count: " + vigilancefails);
	}
	if (vigilancefails >= vigilancecutoff){
		kickedOut = 1;
	}
}

function showPostSurvey(){
	if (postSurveyVisible){
		return;
	}
	postSurveyVisible = true;
	saveProgress();
	stopExperimentTimer();
	var rememberedSample = selectPostSurveyImages();
	var rememberedHtml = rememberedSample.map(function(url, index){
		var label = imageLabelFromUrl(url);
		var textareaId = index === 0 ? "remember-features-a" : "remember-features-b";
		var textareaName = index === 0 ? "remember_features_a" : "remember_features_b";
		return `
			<div class="image-choice">
				<div><strong>${label}</strong></div>
				<img src="${url}" alt="${label}">
				<textarea id="${textareaId}" name="${textareaName}" class="textarea-field" required placeholder="Describe the feature(s) that helped you remember."></textarea>
			</div>
		`;
	}).join("");
	var content = `
		<form id="form" class="card" autocomplete="off">
			<input type="hidden" name="imseq" id="imseqout" value="">
			<input type="hidden" name="imtypeseq" id="imtypeseqout" value="">
			<input type="hidden" name="perfseq" id="perfseqout" value="">
			<input type="hidden" name="ending" id="endingout" value="">
			<input type="hidden" name="post_image_options" id="post-image-options" value="">

			<h1 class="section-title">Post-sequence questions</h1>
			<div class="question-block">
				<label class="muted-text">Describe what features make each image memorable. *</label>
                <p class="small-note">Example: “The bright red diagonal line and the clustered dots in the upper-left made it memorable.”</p>
				<div class="image-pair">
					${rememberedHtml}
				</div>
			</div>
			<div class="question-block">
				<label class="muted-text" for="study-comments">What comments do you have about the study?</label>
				<textarea id="study-comments" name="study_comments" class="textarea-field" placeholder="Optional feedback"></textarea>
			</div>
			<div class="action-row">
				<button type="submit" class="primary-button">Submit Session</button>
			</div>
		</form>
	`;
	document.body.innerHTML = renderShell(content);

	var imseqInput = document.getElementById("imseqout");
	var imtypeInput = document.getElementById("imtypeseqout");
	var perfInput = document.getElementById("perfseqout");
	var endingInput = document.getElementById("endingout");
	var postOptionsInput = document.getElementById("post-image-options");
	if (imseqInput){ imseqInput.value = imgstring; }
	if (imtypeInput){ imtypeInput.value = imtypestring; }
	if (perfInput){ perfInput.value = perfstring; }
	if (endingInput){ endingInput.value = endingStatus || "completed"; }
	if (postOptionsInput){ postOptionsInput.value = rememberedSample.join(","); }

	var postForm = document.getElementById("form");
	if (postForm){
		setEnglishValidationMessages(postForm);
		var handlePostSubmit = async function(e){
			if (e){
				e.preventDefault();
			}
			if (!postForm.reportValidity()){
				return;
			}
			postSurveyResponses.rememberedImage = "";
			postSurveyResponses.rememberFeaturesA = (document.getElementById("remember-features-a").value || "").trim();
			postSurveyResponses.rememberFeaturesB = (document.getElementById("remember-features-b").value || "").trim();
			postSurveyResponses.studyComments = (document.getElementById("study-comments").value || "").trim();
			await sendToSheets();
			var thanks = `
				<section class="card text-center">
					<h1 class="section-title">Submission Received</h1>
					<p class="lead-text">Thank you for supporting the Computer Vision Lab. Your responses have been securely recorded.</p>
					<p class="irb-note">You may now close this window.</p>
				</section>
			`;
			document.body.innerHTML = renderShell(thanks);
		};
		postForm.onsubmit = handlePostSubmit;
		var submitButton = postForm.querySelector("button[type='submit']");
		if (submitButton){
			submitButton.addEventListener("click", handlePostSubmit);
		}
	}
}

function selectPostSurveyImages(){
	var hitIndexes = {};
	var missIndexes = {};
	for (var i = 0; i < typesequence.length; i++){
		var t = typesequence[i];
		if (t === REPEAT || t === VIGILANCE){
			if (perfsequence[i] === HIT){
				hitIndexes[i] = true;
			} else if (perfsequence[i] === MISS){
				missIndexes[i] = true;
			}
		}
	}
	for (var j = 1; j < typesequence.length; j++){
		if (typesequence[j] === FIXATION && perfsequence[j] === HIT){
			var prevType = typesequence[j - 1];
			if (prevType === REPEAT || prevType === VIGILANCE){
				hitIndexes[j - 1] = true;
				delete missIndexes[j - 1];
			}
		}
	}

	var hits = Object.keys(hitIndexes).map(function(key){
		return fullsequence[Number(key)];
	});
	var misses = Object.keys(missIndexes).map(function(key){
		return fullsequence[Number(key)];
	});
	shuffleArray(hits);
	shuffleArray(misses);

	var selection = [];
	if (misses.length > 0){
		selection.push(misses[0]);
		if (hits.length > 0){
			selection.push(hits.find(function(url){ return url !== misses[0]; }) || hits[0]);
		} else if (misses.length > 1){
			selection.push(misses[1]);
		}
	} else {
		selection = hits.slice(0, 2);
	}

	if (selection.length < 2){
		var pool = (sessionImagesCatalog && sessionImagesCatalog.length ? sessionImagesCatalog : (allImagesCatalog || [])).slice();
		shuffleArray(pool);
		for (var k = 0; k < pool.length && selection.length < 2; k++){
			if (selection.indexOf(pool[k]) === -1){
				selection.push(pool[k]);
			}
		}
	}
	return selection;
}

// visually show their failure!
function showFailure(){
	stopExperimentTimer();
	document.getElementById("performancerecord").innerHTML = failuretext;
	propcompleted = imCount/fullsequence.length*100;
	propcompleted = propcompleted.toFixed(2);
	endingStatus = "failed@" + propcompleted + "%";
	var endingInput = document.getElementById("endingout");
	if (endingInput){
		endingInput.value = endingStatus;
	}
	experimentCompleted = true;
	showPostSurvey();
}

function showLevelTransition(nextLevel){
	var levelLabel = nextLevel ? ("Level " + nextLevel) : "Next Level";
	var content = `
		<section class="card text-center">
			<h1 class="section-title">Level Complete</h1>
			<p class="lead-text">You finished the current level. Would you like to continue to ${levelLabel}?</p>
			<div class="action-row">
				<button class="primary-button" onclick="startLevel('${nextLevel}')">Start ${levelLabel}</button>
				<button class="primary-button" style="margin-left:12px;" onclick="finishStudyEarly()">Finish Study</button>
			</div>
		</section>
	`;
	document.body.innerHTML = renderShell(content);
}

function finishStudyEarly(){
	stopExperimentTimer();
	experimentCompleted = true;
    stopAfterLevel = currentLevelKey || "";
	endingStatus = "partial_complete";
    if (typeof persistTrialCheckpoint === "function"){
        persistTrialCheckpoint();
    }
	var endingInput = document.getElementById("endingout");
	if (endingInput){
		endingInput.value = endingStatus;
	}
	showPostSurvey();
}

// end the game if they make it to the end!
function showEnding(){
	stopExperimentTimer();
	if (completedLevels.indexOf(currentLevelKey) === -1){
		completedLevels.push(currentLevelKey);
	}
	var nextLevel = getNextLevelKey();
	if (nextLevel){
		showLevelTransition(nextLevel);
		return;
	}
	experimentCompleted = true;
	endingStatus = "completed";
    if (typeof persistTrialCheckpoint === "function"){
        persistTrialCheckpoint();
    }
	var endingInput = document.getElementById("endingout");
	if (endingInput){
		endingInput.value = endingStatus;
	}
	document.getElementById("performancerecord").innerHTML = donetext;
	showPostSurvey();
}

// create the memorability-based image sequence

function randomInt(min, max){
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function findPairWithDelay(slots, minDelay, maxDelay){
	for (var i = 0; i < slots.length; i++){
		if (slots[i] !== null){
			continue;
		}
		for (var d = minDelay; d <= maxDelay; d++){
			var j = i + d;
			if (j < slots.length && slots[j] === null){
				return [i, j];
			}
		}
	}
	return null;
}

function findLargestGapPair(slots){
	var open = [];
	for (var i = 0; i < slots.length; i++){
		if (slots[i] === null){
			open.push(i);
		}
	}
	if (open.length < 2){
		return null;
	}
	var best = [open[0], open[1]];
	var bestGap = best[1] - best[0];
	for (var i = 0; i < open.length; i++){
		for (var j = i + 1; j < open.length; j++){
			var gap = open[j] - open[i];
			if (gap > bestGap){
				bestGap = gap;
				best = [open[i], open[j]];
			}
		}
	}
	return best;
}

function placePair(slots, types, perf, item, firstType, secondType, minDelay, maxDelay, label){
	var total = slots.length;
	var placed = false;
	for (var attempt = 0; attempt < 200; attempt++){
		var delay = randomInt(minDelay, maxDelay);
		var first = randomInt(0, Math.max(0, total - delay - 1));
		var second = first + delay;
		if (second < total && slots[first] === null && slots[second] === null){
			slots[first] = item;
			types[first] = firstType;
			perf[first] = CORRECTREJECTION;
			slots[second] = item;
			types[second] = secondType;
			perf[second] = MISS;
			placed = true;
			break;
		}
	}
	if (!placed){
		var pair = findPairWithDelay(slots, minDelay, maxDelay);
		if (!pair){
			pair = findLargestGapPair(slots);
		}
		if (!pair){
			console.warn("Unable to place pair for", label);
			return false;
		}
		var gap = pair[1] - pair[0];
		if (gap < minDelay || gap > maxDelay){
			console.warn("Placed", label, "with gap", gap, "outside preferred range", minDelay + "-" + maxDelay);
		}
		slots[pair[0]] = item;
		types[pair[0]] = firstType;
		perf[pair[0]] = CORRECTREJECTION;
		slots[pair[1]] = item;
		types[pair[1]] = secondType;
		perf[pair[1]] = MISS;
	}
	return true;
}

function buildLevelSequence(levelKey){
	var level = manifestData.levels[levelKey];
	if (!level){
		throw new Error("Missing level data for " + levelKey);
	}
	var targets = shuffleArray(level.targets.slice());
	var fillers = shuffleArray(level.fillers.slice());
	var vigilance = shuffleArray(level.vigilance.slice());
	var totalSlots = levelTrialCount;

	function tryBuildOnce(){
		var slots = new Array(totalSlots).fill(null);
		var types = new Array(totalSlots).fill(null);
		var perf = new Array(totalSlots).fill(null);

		var targetLagMin = targetRepeatDelayMin;
		var targetLagMax = targetRepeatDelayMax;
		if (typeof devFastMode !== "undefined" && devFastMode && totalSlots <= 40){
			targetLagMin = 1;
			targetLagMax = Math.max(2, Math.min(6, totalSlots - 2));
		}

		// strict target placement
		for (var t = 0; t < targets.length; t++){
			var item = targets[t];
			var placed = false;
			for (var attempt = 0; attempt < 400; attempt++){
				var lag = randomInt(targetLagMin, targetLagMax);
				var maxFirst = totalSlots - lag - 1;
				if (maxFirst < 0){
					break;
				}
				var first = randomInt(0, maxFirst);
				var second = first + lag;
				if (slots[first] === null && slots[second] === null){
					slots[first] = item;
					types[first] = TARGET;
					perf[first] = CORRECTREJECTION;
					slots[second] = item;
					types[second] = REPEAT;
					perf[second] = MISS;
					placed = true;
					break;
				}
			}
			if (!placed){
				return null;
			}
		}

		// strict vigilance placement
		for (var v = 0; v < vigilance.length; v++){
			var vItem = vigilance[v];
			var vPlaced = false;
			for (var vAttempt = 0; vAttempt < 400; vAttempt++){
				var vLag = randomInt(1, vigilanceRepeatMaxGap);
				var vMaxFirst = totalSlots - vLag - 1;
				if (vMaxFirst < 0){
					break;
				}
				var vFirst = randomInt(0, vMaxFirst);
				var vSecond = vFirst + vLag;
				if (slots[vFirst] === null && slots[vSecond] === null){
					slots[vFirst] = vItem;
					types[vFirst] = FILLER;
					perf[vFirst] = CORRECTREJECTION;
					slots[vSecond] = vItem;
					types[vSecond] = VIGILANCE;
					perf[vSecond] = MISS;
					vPlaced = true;
					break;
				}
			}
			if (!vPlaced){
				return null;
			}
		}

		// fill remaining slots with filler singles
		var fillerSingles = [];
		for (var f = 0; f < fillers.length; f++){
			if (vigilance.indexOf(fillers[f]) === -1){
				fillerSingles.push(fillers[f]);
			}
		}
		fillerSingles = shuffleArray(fillerSingles);
		var fillCursor = 0;
		for (var i = 0; i < totalSlots; i++){
			if (slots[i] === null){
				if (fillCursor >= fillerSingles.length){
					return null;
				}
				slots[i] = fillerSingles[fillCursor++];
				types[i] = FILLER;
				perf[i] = CORRECTREJECTION;
			}
		}

		return { sequence: slots, types: types, perf: perf };
	}

	for (var tries = 0; tries < 240; tries++){
		var built = tryBuildOnce();
		if (built){
			return built;
		}
	}
	throw new Error("Unable to build valid sequence for level " + levelKey + " under strict constraints");
}

function makeImSequence(){
	var built = buildLevelSequence(currentLevelKey);
	allimgseq = built.sequence.slice();
	imtypeseq = built.types.slice();
	performanceseq = built.perf.slice();
	console.log("Done making the image sequence for level", currentLevelKey, "with", allimgseq.length, "trials.");
}

// calculate the proportions of targets and foils
function calculateProps(){
	var trialtime = stimtime + isi;
	trialsBetweenBreaks = Math.ceil(timeBetweenBreaks * 1000 / trialtime);
	var level = manifestData.levels[currentLevelKey] || { targets: [], fillers: [], vigilance: [] };
	numtargets = level.targets.length;
	numfoils = level.fillers.length;
	console.log("Level", currentLevelKey, "targets:", numtargets, "fillers:", numfoils, "vigilance:", level.vigilance.length);
}

// calculate the total pay for the whole study
function calculateTotalPay(){
	var proptargets = images.length / numtargets;
	numtotalsubs = proptargets * subsperim;
	
	experimentlength = (imtypeseq.length * (stimtime + isi)/1000)/60;
	paypersub = experimentlength/60 * payperhour;
	totalpay = paypersub * numtotalsubs;
	
	console.log("Calculated the pay amounts.");
}

function reportVariables(){
	var report = " With your " + images.length + " total images, and a target repeat delay of " + targetRepeatDelayMin + "-" + targetRepeatDelayMax + " images,\n You will need " + numtargets + " targets and " + numfoils + " foils.\n This will result in an experiment that is " + experimentlength + "min long.\n To get " + subsperim + " subjects per target image, you will need " + numtotalsubs + " total subjects.\n At a rate of $" + payperhour + " per hour, each experiment will cost $" + paypersub + ",\n Or $" + totalpay + " for the whole study.";
	
	console.log(report);
}

function typeLabelFromId(typeId){
    if (typeId === TARGET){ return "target_first"; }
    if (typeId === REPEAT){ return "target_repeat"; }
    if (typeId === FILLER){ return "filler_first"; }
    if (typeId === VIGILANCE){ return "vigilance_repeat"; }
    if (typeId === FIXATION){ return "fixation"; }
    return "unknown";
}

function imageIdFromUrl(url){
    var file = (url || "").split("/").pop() || "";
    var dot = file.lastIndexOf(".");
    return dot > 0 ? file.substring(0, dot) : file;
}

function collectTrialEvent(index){
    if (index < 0 || index >= fullsequence.length){
        return;
    }
    var typeId = typesequence[index];
    if (typeId === FIXATION){
        return;
    }
    var perf = perfsequence[index];
    var row = {
        event_type: "trial",
        timestamp_iso: new Date().toISOString(),
        user_id: pid || "",
        participant_id: pid || "",
        session_id: currentSessionId || ((pid || "anon") + "-" + (experimentStartTimestamp || Date.now())),
        study_version: studyVersion || "vis-mem-v2",
        level_index: Number(currentLevelKey || 0),
        trial_index: index,
        image_id: imageIdFromUrl(fullsequence[index]),
        image_url: fullsequence[index],
        trial_type: typeLabelFromId(typeId),
        is_repeat: (typeId === REPEAT || typeId === VIGILANCE) ? 1 : 0,
        expected_response: (typeId === REPEAT || typeId === VIGILANCE) ? 1 : 0,
        participant_response: (perf === HIT || perf === FALSEALARM) ? 1 : 0,
        is_correct: (perf === HIT || perf === CORRECTREJECTION) ? 1 : 0,
        rt_ms: "",
        repeat_lag: "",
        vigilance_flag: (typeId === VIGILANCE) ? 1 : 0,
        false_alarm_flag: (perf === FALSEALARM) ? 1 : 0,
        hit_flag: (perf === HIT) ? 1 : 0,
        miss_flag: (perf === MISS) ? 1 : 0,
        quality_gate_status: kickedOut ? "failed" : "ok",
        quality_gate_reason: kickedOut ? "threshold_exceeded" : "",
        levels_completed: completedLevels.length,
        stop_after_level: "",
        pre_survey_submitted: preSurveyResponses && preSurveyResponses.workerId ? 1 : 0,
        post_survey_submitted: 0,
        pre_q1: preSurveyResponses.takenBefore || "",
        pre_q2: preSurveyResponses.gender || "",
        pre_q3: preSurveyResponses.age || "",
        pre_q4: preSurveyResponses.education || "",
        pre_q5: preSurveyResponses.complexVizDesc || "",
        post_q1: "",
        post_q2: "",
        post_q3: "",
        post_q4: "",
        post_q5: "",
        post_q6: "",
        post_q7: "",
        post_q8: "",
        client_meta_json: ""
    };
    row.event_id = row.session_id + ":trial:" + row.trial_index;
    trialEventRows.push(row);

    if (typeof persistTrialCheckpoint === "function" && trialEventRows.length - lastCheckpointTrialCount >= checkpointEveryTrials){
        lastCheckpointTrialCount = trialEventRows.length;
        persistTrialCheckpoint();
    }
}

// save to the output variables the performance and sequence completed so far
function saveProgress(){
	if (imCount >= 0 && imCount < fullsequence.length && fullsequence[imCount]) {
		var tempimg = fullsequence[imCount];
		tempimg = tempimg.substring(tempimg.lastIndexOf("/")+1);
		if (imCount > 0) {
			imgstring = imgstring + ",";
			imtypestring = imtypestring + ",";
			perfstring = perfstring + ",";
		}
		imgstring = imgstring + tempimg;
		imtypestring = imtypestring + typesequence[imCount];
		perfstring = perfstring + perfsequence[imCount];
        collectTrialEvent(imCount);
		document.getElementById("imseqout").value = imgstring;
		document.getElementById("imtypeseqout").value = imtypestring;
		document.getElementById("perfseqout").value = perfstring;
	}
}

