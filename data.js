async function loadStimulusCatalog(){
    const response = await fetch(stimulusCatalogUrl, { cache: "no-store" });
    if (!response.ok){
        throw new Error("Stimulus catalog HTTP " + response.status);
    }
    const catalog = await response.json();
    if (catalog.version !== stimulusCatalogVersion || catalog.images.length !== 1800){
        throw new Error("Unexpected stimulus catalog version or size");
    }
    const images = catalog.images.map(function(record){
        return {
            filename: record.filename,
            url: catalog.baseUrl + encodeURIComponent(record.filename),
            stratum: record.stratum
        };
    });
    if (new Set(images.map(function(record){ return record.url; })).size !== images.length ||
        images.some(function(record){ return !record.stratum; })){
        throw new Error("Stimulus catalog contains duplicate URLs or missing strata");
    }
    return images;
}

function hashString(str){
    var h = 2166136261;
    for (var i = 0; i < str.length; i++){
        h ^= str.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
}

function hashHex(str){
    return hashString(String(str || "")).toString(16).padStart(8, "0");
}

function makeSeededRng(seed){
    var s = seed >>> 0;
    return function(){
        s += 0x6D2B79F5;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleWithRng(arr, rng){
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--){
        var j = Math.floor(rng() * (i + 1));
        var tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
    }
    return a;
}

function makeSequenceRng(label){
    if (!sequenceContext || !sequenceContext.seedInput){
        throw new Error("Session sequence seed has not been initialized");
    }
    return makeSeededRng(hashString(sequenceContext.seedInput + "|" + label));
}

function makeStratifiedSampler(records, rng){
    var groups = new Map();
    records.forEach(function(record){
        if (!groups.has(record.stratum)){
            groups.set(record.stratum, []);
        }
        groups.get(record.stratum).push(record);
    });
    var buckets = Array.from(groups.values(), function(group){
        return shuffleWithRng(group, rng);
    });

    return function draw(count){
        var total = buckets.reduce(function(sum, bucket){ return sum + bucket.length; }, 0);
        if (count > total){
            throw new Error("Not enough images in the shared stimulus catalog");
        }
        // One random offset rounds proportional quotas while preserving the total.
        var offset = rng();
        var cumulative = 0;
        var selected = [];
        shuffleWithRng(buckets, rng).forEach(function(bucket){
            var before = Math.floor(cumulative * count / total + offset);
            cumulative += bucket.length;
            var quota = Math.floor(cumulative * count / total + offset) - before;
            for (var i = 0; i < quota; i++){
                selected.push(bucket.pop().url);
            }
        });
        return selected;
    };
}

function usesTargetSlot(participantId){
    return !devFastMode && !/^QA_/.test(String(participantId || ""));
}

async function reserveTargetSlot(participantId){
    if (!usesTargetSlot(participantId) ||
        (activeTargetSlot && activeTargetSlot.participantId === participantId)){
        return;
    }
    if (!participantId){
        throw new Error("missing_participant_id");
    }
    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, 20000);
    var response;
    try {
        response = await postPayload(sheetAppsUrl, {
            action: "claim_target_slot",
            participant_id: participantId,
            plan_version: studyVersion,
            catalog_version: stimulusCatalogVersion
        }, controller.signal);
    } finally {
        clearTimeout(timeout);
    }
    var urlsByFilename = new Map(manifestData.catalog.map(function(record){
        return [record.filename, record.url];
    }));
    if (response.plan_version !== studyVersion || response.catalog_version !== stimulusCatalogVersion ||
        typeof response.slot_id !== "string" || !response.slot_id ||
        !Array.isArray(response.targets) || response.targets.length !== activeLevelCount ||
        !response.targets.every(function(level){ return Array.isArray(level) && level.length === 16; })){
        throw new Error("invalid_target_slot");
    }
    var levels = response.targets.map(function(level){
        return level.map(function(filename){ return urlsByFilename.get(filename); });
    });
    var targets = levels.flat();
    if (targets.some(function(url){ return !url; }) || new Set(targets).size !== targets.length){
        throw new Error("invalid_target_slot_images");
    }
    activeTargetSlot = {
        participantId: participantId,
        slotId: response.slot_id,
        planVersion: response.plan_version,
        levels: levels
    };
}

function targetSlotForParticipant(participantId){
    if (!usesTargetSlot(participantId)){
        return null;
    }
    if (!activeTargetSlot || activeTargetSlot.participantId !== participantId){
        throw new Error("target_slot_required");
    }
    return activeTargetSlot;
}

function targetSlotMetadata(){
    var slot = usesTargetSlot(pid) && activeTargetSlot && activeTargetSlot.participantId === pid
        ? activeTargetSlot : null;
    return { slot_id: slot ? slot.slotId : "", plan_version: slot ? slot.planVersion : "" };
}

function practiceImagesForSession(participantId, sessionId){
    var rng = makeSeededRng(hashString(stimulusCatalogVersion + "|practice|" + participantId + "|" + sessionId));
    var slot = targetSlotForParticipant(participantId);
    var targets = new Set(slot ? slot.levels.flat() : []);
    var pool = manifestData.catalog.filter(function(record){ return !targets.has(record.url); });
    return makeStratifiedSampler(pool, rng)(17);
}

function initializeParticipantLevels(participantId, sessionId){
    if (!manifestData || !manifestData.catalog){
        throw new Error("Stimulus catalog not loaded");
    }
    var levelCount = activeLevelCount || 5;
    var levelKeys = [];
    for (var i = 1; i <= levelCount; i++){
        levelKeys.push(String(i));
    }

    var normalizedParticipantId = String(participantId || "anon");
    var normalizedSessionId = String(sessionId || currentSessionId || (normalizedParticipantId + "-session"));
    var slot = targetSlotForParticipant(normalizedParticipantId);
    var seedInput = [
        sequenceAlgorithm,
        studyVersion || "pilot2-v1",
        studySalt || "salt",
        normalizedParticipantId,
        normalizedSessionId,
        slot ? slot.slotId : ""
    ].join("|");
    sequenceContext = {
        algorithm: sequenceAlgorithm,
        seedInput: seedInput,
        seedHash: hashHex(seedInput),
        assignmentHash: "",
        levelSequenceHashes: {}
    };

    var practiceUrls = new Set(practiceImagesForSession(normalizedParticipantId, normalizedSessionId));
    var targetUrls = new Set(slot ? slot.levels.flat() : []);
    var formalPool = manifestData.catalog.filter(function(record){
        return !practiceUrls.has(record.url) && !targetUrls.has(record.url);
    });
    var draw = makeStratifiedSampler(formalPool, makeSequenceRng("shared-pool"));

    var effectiveLevelTrialCount = levelTrialCount;
    if (typeof devFastMode !== "undefined" && devFastMode){
        effectiveLevelTrialCount = Math.max(2, devLevelTrialCount);
    }

    // Per-level design budget (must fit levelTrialCount and lag constraints)
    var targetPairsPerLevel = 16; // production default
    var vigilancePairsPerLevel = 6; // production default

    // Dev fast mode guard: shrink pair counts so tiny trial counts can still build sequences
    if (typeof devFastMode !== "undefined" && devFastMode && effectiveLevelTrialCount <= 40){
        targetPairsPerLevel = Math.max(1, Math.floor(effectiveLevelTrialCount * 0.15));
        vigilancePairsPerLevel = effectiveLevelTrialCount <= 6 ? 0 : Math.max(1, Math.floor(effectiveLevelTrialCount * 0.05));
    }

    var fillerSinglesPerLevel = Math.max(0, effectiveLevelTrialCount - (targetPairsPerLevel * 2) - (vigilancePairsPerLevel * 2));

    var levels = {};
    levelKeys.forEach(function(levelKey, index){
        levels[levelKey] = { targets: slot ? slot.levels[index].slice() : draw(targetPairsPerLevel) };
    });
    levelKeys.forEach(function(levelKey){
        var level = levels[levelKey];
        level.vigilance = draw(vigilancePairsPerLevel);
        level.fillers = draw(fillerSinglesPerLevel).concat(level.vigilance);
    });

    var assignmentParts = [];
    levelKeys.forEach(function(levelKey){
        var level = levels[levelKey];
        assignmentParts.push(
            levelKey + "|targets|" + level.targets.join(",") +
            "|vigilance|" + level.vigilance.join(",") +
            "|fillers|" + level.fillers.join(",")
        );
    });
    sequenceContext.assignmentHash = hashHex(assignmentParts.join("||"));

    manifestData.levels = levels;
    manifestData.sequenceContext = sequenceContext;
    availableLevels = levelKeys.slice();
    allImagesCatalog = [];
    availableLevels.forEach(function(levelKey){
        var level = levels[levelKey];
        allImagesCatalog = allImagesCatalog.concat(level.targets, level.fillers);
    });
    return levels;
}

function ensureImagesLoaded(){
    if (!imageLoadPromise){
        imageLoadPromise = loadStimulusCatalog().then(function(catalog){
            manifestData = { catalog: catalog, levels: {} };
            availableLevels = [];
            allImagesCatalog = catalog.map(function(record){ return record.url; });
            return manifestData;
        }).catch(function(err){
            console.error("Failed to load manifests", err);
            manifestData = null;
            availableLevels = [];
            allImagesCatalog = [];
            return null;
        });
    }
    return imageLoadPromise;
}

async function requireImagesReady(){
    await ensureImagesLoaded();
    if (!manifestData || !manifestData.catalog){
        throw new Error("No manifest data loaded");
    }
    return manifestData;
}
