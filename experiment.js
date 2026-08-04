function uniqueImageUrls(urls) {
    var seen = {};
    return (urls || []).filter(function(url){
        if (!url || seen[url]){
            return false;
        }
        seen[url] = true;
        return true;
    });
}

function monotonicNow(){
    return performance.now();
}

function nextAnimationFrame(){
    return new Promise(function(resolve){
        requestAnimationFrame(function(timestamp){
            resolve(timestamp);
        });
    });
}

function scheduleAfterVisibleDuration(onset, duration, callback){
    var deadline = onset + duration;
    function waitForDeadline(timestamp){
        if (timestamp >= deadline){
            callback();
            return;
        }
        requestAnimationFrame(waitForDeadline);
    }
    requestAnimationFrame(waitForDeadline);
}

function stimulusLayersMarkup(altText){
    return `
        <img id="stimulus" class="stimulus-layer stimulus-layer-active" src="${fixation_address}" alt="${altText}">
        <img id="stimulus-buffer" class="stimulus-layer" src="${fixation_address}" alt="" aria-hidden="true">
    `;
}

function stimulusLayers(){
    var first = document.getElementById("stimulus");
    var second = document.getElementById("stimulus-buffer");
    if (!first || !second){
        throw new Error("Stimulus layers are missing");
    }
    return activeStimulusElementId === "stimulus-buffer" ? [second, first] : [first, second];
}

function loadAndDecodeImage(url){
    return new Promise(function(resolve, reject){
        var image = new Image();
        var settled = false;
        var decodingStarted = false;
        var timeoutId = setTimeout(function(){
            fail("timed out after " + imagePreloadTimeoutMs + " ms");
        }, imagePreloadTimeoutMs);

        function fail(reason){
            if (settled){
                return;
            }
            settled = true;
            clearTimeout(timeoutId);
            reject(new Error("Unable to preload image: " + url + (reason ? " (" + reason + ")" : "")));
        }

        function succeed(){
            if (settled){
                return;
            }
            settled = true;
            clearTimeout(timeoutId);
            resolve(image);
        }

        function decodeLoadedImage(){
            if (settled || decodingStarted){
                return;
            }
            decodingStarted = true;
            if (!image.decode){
                succeed();
                return;
            }
            image.decode().then(function(){
                succeed();
            }).catch(function(err){
                fail(err && err.message ? err.message : "decode failed");
            });
        }

        image.decoding = "async";
        image.loading = "eager";
        image.onload = decodeLoadedImage;
        image.onerror = function(){ fail("download failed"); };
        image.src = url;

        if (image.complete){
            if (image.naturalWidth > 0){
                decodeLoadedImage();
            } else {
                fail("empty image");
            }
        }
    });
}

async function preloadImagesForBlock(urls, onProgress){
    var uniqueUrls = uniqueImageUrls(urls);
    var assets = new Map();
    var completed = 0;
    var nextIndex = 0;
    var workerCount = Math.min(6, uniqueUrls.length);

    if (onProgress){
        onProgress(0, uniqueUrls.length, "");
    }
    if (!uniqueUrls.length){
        preloadedImageAssets = assets;
        return assets;
    }

    async function worker(){
        while (nextIndex < uniqueUrls.length){
            var index = nextIndex;
            nextIndex++;
            var url = uniqueUrls[index];
            var asset = await loadAndDecodeImage(url);
            assets.set(url, asset);
            completed++;
            if (onProgress){
                onProgress(completed, uniqueUrls.length, url);
            }
        }
    }

    var workers = [];
    for (var i = 0; i < workerCount; i++){
        workers.push(worker());
    }
    await Promise.all(workers);
    preloadedImageAssets = assets;
    return assets;
}

function updatePreloadProgress(completed, total){
    var bar = document.getElementById("preload-progress");
    var label = document.getElementById("preload-progress-label");
    var percent = total ? Math.round((completed / total) * 100) : 100;
    if (bar){
        bar.style.width = percent + "%";
        bar.setAttribute("aria-valuenow", String(percent));
    }
    if (label){
        label.textContent = completed + " / " + total + " images ready (" + percent + "%)";
    }
}

function showPreloadFailure(err, retry){
    var status = document.getElementById("preload-status-text");
    var actions = document.getElementById("preload-actions");
    if (status){
        status.textContent = "Some images could not be prepared. Check your connection and retry before continuing.";
        status.classList.add("preload-error");
    }
    if (actions){
        actions.innerHTML = '<button type="button" id="retry-preload" class="primary-button">Retry Loading</button>';
        document.getElementById("retry-preload").onclick = retry;
    }
    console.error("Image preload failed", err);
}

async function prepareBlockImages(urls, readyMessage, retry){
    blockAssetsReady = false;
    trialPresentationPending = false;
    preloadedImageAssets = new Map();
    var status = document.getElementById("preload-status-text");
    var actions = document.getElementById("preload-actions");
    if (status){
        status.textContent = "Downloading and decoding images before the block begins...";
        status.classList.remove("preload-error");
    }
    if (actions){
        actions.innerHTML = "";
    }
    try {
        await preloadImagesForBlock(uniqueImageUrls((urls || []).concat([fixation_address])), updatePreloadProgress);
        blockAssetsReady = true;
        if (status){
            status.textContent = readyMessage;
        }
        return true;
    } catch (err){
        showPreloadFailure(err, retry);
        return false;
    }
}

async function presentStimulusAfterPaint(url, beforeActivate, afterActivate){
    if (!blockAssetsReady || !preloadedImageAssets.has(url)){
        throw new Error("Stimulus was not preloaded: " + url);
    }
    var layers = stimulusLayers();
    var current = layers[0];
    var next = layers[1];
    next.src = url;
    if (next.decode){
        await next.decode();
    }
    return new Promise(function(resolve){
        requestAnimationFrame(function(timestamp){
            if (beforeActivate && beforeActivate(timestamp) === false){
                resolve({ activated: false, onset: timestamp });
                return;
            }
            next.classList.add("stimulus-layer-active");
            current.classList.remove("stimulus-layer-active");
            activeStimulusElementId = next.id;
            if (afterActivate){
                afterActivate(timestamp);
            }
            resolve({ activated: true, onset: timestamp });
        });
    });
}

function preloadStatusMarkup(){
    return `
        <div class="preload-status" aria-live="polite">
            <p id="preload-status-text" class="instruction-callout">Preparing images...</p>
            <div class="progress-track" role="progressbar" aria-label="Image loading progress" aria-valuemin="0" aria-valuemax="100">
                <div id="preload-progress" class="progress-bar" aria-valuenow="0"></div>
            </div>
            <div id="preload-progress-label" class="progress-label">0 / 0 images ready (0%)</div>
            <div id="preload-actions" class="action-row preload-actions"></div>
        </div>
    `;
}

function selectPretrainImages() {
    var pool = pretestImages.slice();
    shuffleArray(pool);
    return pool.slice(0, Math.min(17, pool.length));
}

// Build pretrain sequence with repeats
function buildPretrainSequence() {
    pretrainImages = selectPretrainImages();

    if (devFastMode) {
        pretrainImages = pretrainImages.slice(0, Math.max(2, devPretrainUniqueCount));
        var firstPractice = pretrainImages[0];
        var secondPractice = pretrainImages[1] || pretrainImages[0];
        pretrainSequence = [firstPractice, secondPractice, firstPractice, secondPractice];
        pretrainTypeSequence = [TARGET, TARGET, REPEAT, REPEAT];
        pretrainPerfSequence = [CORRECTREJECTION, CORRECTREJECTION, MISS, MISS];
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
    
    var targetLength = pretrainImages.length + repeatPositions.length;
    for (var i = 0; i < targetLength; i++) {
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
                <li><strong>Attend carefully.</strong> Each visualization appears for ${(stimtime / 1000).toFixed(1)} seconds, followed by a ${(isi / 1000).toFixed(1)} second fixation interval.</li>
                <li><strong>Respond only to repeats.</strong> Press the <strong>SPACE BAR</strong> as soon as you recognize a repeated image in the active block.</li>
                <li><strong>Remain focused.</strong> Repeats may occur long after first exposure and can closely resemble other images.</li>
            </ol>
            <p class="lead-text">
                Performance monitoring: the system tracks <strong>false alarms</strong> (responding to new images) and <strong>vigilance misses</strong>
                (missing scheduled repeats). False alarms are recorded for data quality. Attention is screened using the most recent
                ${vigilanceWindowSize} vigilance repeats; the session ends if more than ${Math.round(vigilanceWindowMissThreshold * 100)}%
                of those repeats are missed.
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
	devPretrainUniqueCount = 2;
	devPretrainTotalCount = 4;
	devLevelTrialCount = 4;
	showInstructions();
}

// Start pretrain
async function startPretrain() {
	inPretrainMode = true;
	pretrainImCount = -1;
	blockAssetsReady = false;
	trialPresentationPending = false;
	activeStimulusElementId = "stimulus";
	
    // Reset counters
	pretrainHits = 0;
	pretrainMisses = 0;
	pretrainFalseAlarms = 0;
	pretrainCorrectRejections = 0;
	pretrainResponseRegistered = [];
	
	var practiceView = `
		<section class="card">
			<h1 class="section-title">Practice Block</h1>
			<p class="lead-text">
				During practice, respond only when a visualization repeats within this practice block. Use the <strong>SPACE BAR</strong> to register detections.
			</p>
			${preloadStatusMarkup()}
			<div class="stimulus-panel">
				<div id="performancerecord" class="instruction-callout">
					Please wait while the practice images are prepared.
				</div>
				<div class="stimulus-frame">
					${stimulusLayersMarkup("Practice stimulus")}
				</div>
			</div>
			<p class="muted-text">Keyboard input required: SPACE BAR only.</p>
		</section>
	`;
	document.body.innerHTML = renderShell(practiceView);

	var ready = await prepareBlockImages(
		pretrainSequence,
		"Practice images are ready.",
		function(){ void startPretrain(); }
	);
	if (ready){
		document.getElementById("performancerecord").innerHTML = "Please look at the cross when it appears on the screen. Press SPACE to begin the practice sequence.";
	}
}

// Animate pretrain sequence
async function animatePretrainSequence() {
    if (trialPresentationPending || !blockAssetsReady){
        return;
    }
    trialPresentationPending = true;
    var nextIndex = pretrainImCount + 1;
    if (nextIndex >= pretrainSequence.length * 2) { // *2 because we have fixations
        // Pretrain finished
        trialPresentationPending = false;
        showPretrainResults();
        return;
    }

    // Determine if it's an image or fixation
    var isImage = (nextIndex % 2 === 0);
    
    var nextUrl = fixation_address;
    var duration = isi;
    if (isImage) {
        var imgIndex = Math.floor(nextIndex / 2);
        nextUrl = pretrainSequence[imgIndex];
        duration = stimtime;
    }
    try {
        var presentation = await presentStimulusAfterPaint(nextUrl, null, function(){
            pretrainImCount = nextIndex;
        });
        trialPresentationPending = false;
        scheduleAfterVisibleDuration(presentation.onset, duration, animatePretrainSequence);
    } catch (err){
        trialPresentationPending = false;
        blockAssetsReady = false;
        showPreloadFailure(err, function(){ void startPretrain(); });
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
function processPretrainResponse(event) {
    if (!blockAssetsReady || (event && event.repeat)){
        return;
    }
    if (pretrainImCount < 0) {
        if (trialPresentationPending){
            return;
        }
        // Start the pretrain
        document.getElementById("performancerecord").innerHTML = "";
        void animatePretrainSequence();
        return;
    }

    var isImage = (pretrainImCount % 2 === 0);
    var imgIndex = isImage ? Math.floor(pretrainImCount / 2) : Math.floor((pretrainImCount - 1) / 2);
    if (imgIndex < 0 || pretrainResponseRegistered[imgIndex]){
        return;
    }
    pretrainResponseRegistered[imgIndex] = true;

    if (!isImage && pretrainImCount > 0) {
        // They pressed during fixation, check previous image
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

function evaluatePretrainPerformance(types, misses, falseAlarms){
    var totalRepeats = types.filter(function(t){ return t === REPEAT; }).length || 1;
    var totalNovel = types.filter(function(t){ return t !== REPEAT; }).length || 1;
    var missRate = misses / totalRepeats;
    var falseAlarmRate = falseAlarms / totalNovel;
    return {
        totalRepeats: totalRepeats,
        totalNovel: totalNovel,
        missRate: missRate,
        falseAlarmRate: falseAlarmRate,
        passed: missRate < pretrainMissRateThreshold && falseAlarmRate < pretrainFalseAlarmRateThreshold
    };
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
    
    var evaluation = evaluatePretrainPerformance(pretrainTypeSequence, pretrainMisses, pretrainFalseAlarms);
    var totalRepeats = evaluation.totalRepeats;
    var totalNovel = evaluation.totalNovel;
    var accuracy = Math.round((pretrainHits / totalRepeats) * 100);
    var missRate = evaluation.missRate;
    var falseAlarmRate = evaluation.falseAlarmRate;
    var passedPractice = evaluation.passed;
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
						<div class="stat-value">${pretrainFalseAlarms} / ${totalNovel}</div>
					</div>
					<div class="stat-item">
						<div class="stat-label">Miss Rate</div>
						<div class="stat-value">${Math.round(missRate * 100)}%</div>
					</div>
					<div class="stat-item">
						<div class="stat-label">False-alarm Rate</div>
						<div class="stat-value">${Math.round(falseAlarmRate * 100)}%</div>
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
				Practice requires a miss rate below ${Math.round(pretrainMissRateThreshold * 100)}% and a false-alarm rate below ${Math.round(pretrainFalseAlarmRateThreshold * 100)}%. This attempt recorded ${Math.round(missRate * 100)}% misses and ${Math.round(falseAlarmRate * 100)}% false alarms.
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
			${preloadStatusMarkup()}
			<div class="stimulus-panel">
				<div id="performancerecord" class="instruction-callout">Please wait while this level's images are prepared.</div>
				<div class="stimulus-frame">
					${stimulusLayersMarkup("Stimulus image")}
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
	
	// Build the exact level sequence before its unique images are preloaded.
	preloadEverything();
	updateExperimentProgress();
}

async function startLevel(levelKey){
	blockAssetsReady = false;
	trialPresentationPending = false;
	activeStimulusElementId = "stimulus";
	setCurrentLevel(levelKey);
	renderExperimentInterface(levelKey);
	var ready = await prepareBlockImages(
		fullsequence,
		"All images for this level are downloaded and decoded.",
		function(){ void startLevel(levelKey); }
	);
	if (ready){
		document.getElementById("performancerecord").innerHTML = "Press the <b>SPACE BAR</b> to start. If it doesn't work, make sure to click in this browser window first.";
	}
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
    savedProgressKeys = {};
    vigilanceHistory = [];
    submissionInProgress = false;

    try {
        initializeParticipantLevels(pid || "anon", currentSessionId);
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
	void startLevel(nextLevel);
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
            processPretrainResponse(key);
        }
    } else {
        if (isResponseKey(key)){
            key.preventDefault();
            processResponse(key);
        }
    }
};

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
	await startLevel(currentLevelKey);
}

// Recursive function that presents each decoded image and starts timing only after paint.
async function animateSequence(){
	if (trialPresentationPending || !blockAssetsReady){
		return;
	}
	trialPresentationPending = true;
	var previousIndex = imCount;
	var nextIndex = previousIndex + 1;
	if (nextIndex === fullsequence.length){
		if (previousIndex > 0 && typesequence[previousIndex] === FIXATION){
			finalizeTrialPair(previousIndex - 1, previousIndex);
		}
		trialPresentationPending = false;
		if (kickedOut){
			showFailure();
		} else {
			showEnding();
		}
		return;
	}
	try {
		var presentation = await presentStimulusAfterPaint(
			fullsequence[nextIndex],
			function(){
				if (previousIndex > 0 && typesequence[previousIndex] === FIXATION){
					finalizeTrialPair(previousIndex - 1, previousIndex);
				}
				if (kickedOut){
					trialPresentationPending = false;
					showFailure();
					return false;
				}
				return true;
			},
			function(timestamp){
				imCount = nextIndex;
				trialOnsetTimestamps[nextIndex] = timestamp;
				updateExperimentProgress();
				if (nextIndex === 0 && !experimentStartTimestamp){
					startExperimentTimer();
				}
			}
		);
		if (!presentation.activated){
			return;
		}
		trialPresentationPending = false;
		scheduleAfterVisibleDuration(presentation.onset, timesequence[nextIndex], animateSequence);
	} catch (err){
		trialPresentationPending = false;
		blockAssetsReady = false;
		stopExperimentTimer();
		showPreloadFailure(err, function(){ void startLevel(currentLevelKey); });
	}
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
	experimentStartTimestamp = null;
	totalExperimentDuration = 0;
	trialOnsetTimestamps = [];
	trialResponseTimes = [];
	trialResponseWindows = [];
	trialPresentationPending = false;
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
		if (!blockAssetsReady || key.repeat){
			return;
		}
		if (imCount<0) {
			if (trialPresentationPending){
				return;
			}
			document.getElementById("performancerecord").innerHTML = "";
			void animateSequence();
			return;
		}
		var responseIndex = imCount;
		var responseWindow = "stimulus";
		if (typesequence[imCount] === FIXATION && imCount > 0) {
			responseIndex = imCount - 1;
			responseWindow = "fixation_grace";
		}
		var trialtype = typesequence[responseIndex];
		if (trialResponseTimes[responseIndex] !== undefined){
			return;
		}
		if (trialtype === REPEAT || trialtype === VIGILANCE) {
			perfsequence[responseIndex] = HIT;
			console.log("Hit!");
		} else if (trialtype === TARGET || trialtype === FILLER) {
			perfsequence[responseIndex] = FALSEALARM;
			console.log("False alarm!");
		} else {
			return;
		}
		var responseTimestamp = monotonicNow();
		var onsetTimestamp = trialOnsetTimestamps[responseIndex];
		trialResponseTimes[responseIndex] = onsetTimestamp === undefined ? "" : Math.max(0, responseTimestamp - onsetTimestamp);
		trialResponseWindows[responseIndex] = responseWindow;
	}
}

// decide if they've failed too much
function determineFailure(index){
	var trialIndex = typeof index === "number" ? index : imCount;
	if (perfsequence[trialIndex] == FALSEALARM){
		falsealarmcounts++;
		console.log("False alarm count: " + falsealarmcounts);
	}
	
	if (typesequence[trialIndex] == VIGILANCE){
		vigilanceHistory.push(perfsequence[trialIndex]);
	}
	if (perfsequence[trialIndex] === MISS && typesequence[trialIndex] === VIGILANCE){
		vigilancefails++;
		console.log("Vigilance miss count: " + vigilancefails);
	}

	var recentVigilance = vigilanceHistory.slice(-vigilanceWindowSize);
	if (recentVigilance.length < vigilanceWindowSize){
		return;
	}
	var recentMisses = recentVigilance.filter(function(perf){
		return perf == MISS;
	}).length;
	var missCutoff = Math.floor(vigilanceWindowSize * vigilanceWindowMissThreshold) + 1;
	if (recentMisses >= missCutoff){
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
			<p id="submission-status" class="small-note" role="status" aria-live="polite"></p>
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
			if (submissionInProgress){
				return;
			}
			submissionInProgress = true;
			var submitButton = postForm.querySelector("button[type='submit']");
			if (submitButton){
				submitButton.disabled = true;
				submitButton.textContent = "Submitting...";
			}
			var submitStatus = document.getElementById("submission-status");
			if (submitStatus){
				submitStatus.textContent = "Saving all trial and questionnaire data...";
			}
			postSurveyResponses.rememberedImage = "";
			postSurveyResponses.rememberFeaturesA = (document.getElementById("remember-features-a").value || "").trim();
			postSurveyResponses.rememberFeaturesB = (document.getElementById("remember-features-b").value || "").trim();
			postSurveyResponses.studyComments = (document.getElementById("study-comments").value || "").trim();
			var submissionResult = await sendToSheets();
			if (!submissionResult || !submissionResult.ok){
				submissionInProgress = false;
				if (submitButton){
					submitButton.disabled = false;
					submitButton.textContent = "Retry Submission";
				}
				if (submitStatus){
					submitStatus.textContent = "Data could not be fully saved. Check your connection and retry; do not close this window.";
					submitStatus.style.color = "var(--error)";
				}
				return;
			}
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

function randomInt(min, max, rng){
	var randomSource = typeof rng === "function" ? rng : Math.random;
	return Math.floor(randomSource() * (max - min + 1)) + min;
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
	var rng = makeSequenceRng("level-sequence-" + levelKey);
	var targets = shuffleWithRng(level.targets, rng);
	var fillers = shuffleWithRng(level.fillers, rng);
	var vigilance = shuffleWithRng(level.vigilance, rng);
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
				var lag = randomInt(targetLagMin, targetLagMax, rng);
				var maxFirst = totalSlots - lag - 1;
				if (maxFirst < 0){
					break;
				}
				var first = randomInt(0, maxFirst, rng);
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
				var vLag = randomInt(1, vigilanceRepeatMaxGap, rng);
				var vMaxFirst = totalSlots - vLag - 1;
				if (vMaxFirst < 0){
					break;
				}
				var vFirst = randomInt(0, vMaxFirst, rng);
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
		fillerSingles = shuffleWithRng(fillerSingles, rng);
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
			built.sequenceHash = hashHex(
				String(levelKey) + "|" + built.sequence.join(",") + "|" + built.types.join(",")
			);
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
	if (sequenceContext && sequenceContext.levelSequenceHashes){
		sequenceContext.levelSequenceHashes[String(currentLevelKey)] = built.sequenceHash;
	}
	console.log("Done making the image sequence for level", currentLevelKey, "with", allimgseq.length, "trials.");
}

// calculate the proportions of targets and foils
function calculateProps(){
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

function repeatLagForIndex(index){
    if (typesequence[index] !== REPEAT && typesequence[index] !== VIGILANCE){
        return "";
    }
    for (var previous = index - 1; previous >= 0; previous--){
        if (typesequence[previous] !== FIXATION && fullsequence[previous] === fullsequence[index]){
            var lag = 0;
            for (var cursor = previous + 1; cursor <= index; cursor++){
                if (typesequence[cursor] !== FIXATION){
                    lag++;
                }
            }
            return lag;
        }
    }
    return "";
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
        study_version: studyVersion || "pilot2-v1",
        level_index: Number(currentLevelKey || 0),
        trial_index: index,
        image_id: imageIdFromUrl(fullsequence[index]),
        image_url: fullsequence[index],
        trial_type: typeLabelFromId(typeId),
        is_repeat: (typeId === REPEAT || typeId === VIGILANCE) ? 1 : 0,
        expected_response: (typeId === REPEAT || typeId === VIGILANCE) ? 1 : 0,
        participant_response: (perf === HIT || perf === FALSEALARM) ? 1 : 0,
        is_correct: (perf === HIT || perf === CORRECTREJECTION) ? 1 : 0,
        rt_ms: trialResponseTimes[index] === undefined ? "" : trialResponseTimes[index],
        repeat_lag: repeatLagForIndex(index),
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
        client_meta_json: JSON.stringify({
            response_window: trialResponseWindows[index] || "none",
            run_mode: currentRunMode(),
            schema_version: eventSchemaVersion,
            stimulus_catalog_version: stimulusCatalogVersion,
            client_build_id: clientBuildId,
            stimulus_timing: "preloaded-double-buffer-raf-deadline-v2",
            sequence_algorithm: sequenceContext.algorithm || sequenceAlgorithm || "",
            sequence_seed_hash: sequenceContext.seedHash || "",
            assignment_hash: sequenceContext.assignmentHash || "",
            level_sequence_hash: (sequenceContext.levelSequenceHashes || {})[String(currentLevelKey)] || ""
        })
    };
    row.event_id = row.session_id + ":level:" + row.level_index + ":trial:" + row.trial_index;
    trialEventRows.push(row);

    if (typeof persistTrialCheckpoint === "function" && trialEventRows.length - lastCheckpointTrialCount >= checkpointEveryTrials){
        lastCheckpointTrialCount = trialEventRows.length;
        persistTrialCheckpoint();
    }
}

// Save one sequence entry exactly once. Level is part of the key because indexes reset per level.
function saveProgress(index){
	var progressIndex = typeof index === "number" ? index : imCount;
	var progressKey = String(currentLevelKey || "0") + ":" + progressIndex;
	if (savedProgressKeys[progressKey]){
		return;
	}
	if (progressIndex >= 0 && progressIndex < fullsequence.length && fullsequence[progressIndex]) {
		var tempimg = fullsequence[progressIndex];
		tempimg = tempimg.substring(tempimg.lastIndexOf("/")+1);
		if (imgstring.length > 0) {
			imgstring = imgstring + ",";
			imtypestring = imtypestring + ",";
			perfstring = perfstring + ",";
		}
		imgstring = imgstring + tempimg;
		imtypestring = imtypestring + typesequence[progressIndex];
		perfstring = perfstring + perfsequence[progressIndex];
        collectTrialEvent(progressIndex);
		var imseqOutput = document.getElementById("imseqout");
		var imtypeOutput = document.getElementById("imtypeseqout");
		var perfOutput = document.getElementById("perfseqout");
		if (imseqOutput){ imseqOutput.value = imgstring; }
		if (imtypeOutput){ imtypeOutput.value = imtypestring; }
		if (perfOutput){ perfOutput.value = perfstring; }
		savedProgressKeys[progressKey] = true;
	}
}

function finalizeTrialPair(imageIndex, fixationIndex){
	saveProgress(imageIndex);
	saveProgress(fixationIndex);
	determineFailure(imageIndex);
}
