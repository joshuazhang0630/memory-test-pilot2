function normalizeBaseUrl(base){
    if (!base){
        return "";
    }
    return base.endsWith("/") ? base : (base + "/");
}

async function fetchManifest(url){
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok){
        throw new Error("Manifest HTTP " + res.status + " @ " + url);
    }
    const manifest = await res.json();
    return {
        sourceUrl: url,
        baseUrl: normalizeBaseUrl(manifest.baseUrl || ""),
        files: Array.isArray(manifest.files) ? manifest.files : []
    };
}

async function loadManifests(){
    const targetManifest = await fetchManifest(targetManifestUrl);
    const fillerManifest = await fetchManifest(fillerManifestUrl);
    return { targetManifest: targetManifest, fillerManifest: fillerManifest };
}

function resolveManifestUrl(base, name){
    if (!name){
        return "";
    }
    return name.startsWith("http") ? name : (normalizeBaseUrl(base) + name);
}

function basenameWithoutExt(path){
    if (!path){
        return "";
    }
    const base = path.split("/").pop() || path;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.substring(0, dot) : base;
}

function buildGlobalRegistry(targetManifest, fillerManifest){
    var registry = {
        targets: [],
        fillers: [],
        pretest: [],
        byId: {}
    };

    function pushRecord(kind, fileName, baseUrl){
        var url = resolveManifestUrl(baseUrl, fileName);
        var imageId = basenameWithoutExt(fileName);
        if (!imageId){
            return;
        }
        if (registry.byId[imageId]){
            // keep strict uniqueness by id
            var disambiguated = imageId + "__" + kind + "__" + (Object.keys(registry.byId).length + 1);
            imageId = disambiguated;
        }
        var rec = {
            imageId: imageId,
            fileName: fileName,
            url: url,
            role: kind
        };
        registry.byId[imageId] = rec;
        if (kind === "target"){
            registry.targets.push(rec);
        } else {
            registry.fillers.push(rec);
        }
    }

    targetManifest.files.forEach(function(name){ pushRecord("target", name, targetManifest.baseUrl); });
    fillerManifest.files.forEach(function(name){ pushRecord("filler", name, fillerManifest.baseUrl); });

    // pretest sample from fillers (stable deterministic slice)
    registry.pretest = registry.fillers.slice(0, Math.min(60, registry.fillers.length)).map(function(rec){ return rec.url; });
    return registry;
}

function hashString(str){
    var h = 2166136261;
    for (var i = 0; i < str.length; i++){
        h ^= str.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
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

function splitIntoLevels(items, levelCount){
    var levels = [];
    for (var i = 0; i < levelCount; i++){
        levels.push([]);
    }
    items.forEach(function(item, idx){
        levels[idx % levelCount].push(item);
    });
    return levels;
}

function initializeParticipantLevels(participantId){
    if (!manifestData || !manifestData.registry){
        throw new Error("Manifest registry not loaded");
    }
    var levelCount = activeLevelCount || 5;
    var levelKeys = [];
    for (var i = 1; i <= levelCount; i++){
        levelKeys.push(String(i));
    }

    var seedInput = "pilot2-fixed-level-pools|" + (studyVersion || "pilot2-v1") + "|" + (studySalt || "salt");
    var rng = makeSeededRng(hashString(seedInput));

    var shuffledTargets = shuffleWithRng(manifestData.registry.targets, rng);
    var shuffledFillers = shuffleWithRng(manifestData.registry.fillers, rng);

    // Per-level design budget (must fit levelTrialCount and lag constraints)
    var targetPairsPerLevel = 16; // => 32 slots (more robust strict lag-fit margin)
    var vigilancePairsPerLevel = 6; // => 12 slots
    var fillerSinglesPerLevel = Math.max(0, levelTrialCount - (targetPairsPerLevel * 2) - (vigilancePairsPerLevel * 2)); // default 72

    var neededTargets = targetPairsPerLevel * levelCount;
    var neededVigilance = vigilancePairsPerLevel * levelCount;
    var neededFillers = (fillerSinglesPerLevel * levelCount) + neededVigilance;

    if (shuffledTargets.length < neededTargets){
        throw new Error("Not enough target images for level design budget");
    }
    if (shuffledFillers.length < neededFillers){
        throw new Error("Not enough filler images for level design budget");
    }

    var tCursor = 0;
    var fCursor = 0;
    var levels = {};

    levelKeys.forEach(function(levelKey){
        var levelTargets = shuffledTargets.slice(tCursor, tCursor + targetPairsPerLevel).map(function(r){ return r.url; });
        tCursor += targetPairsPerLevel;

        var vigilanceSources = shuffledFillers.slice(fCursor, fCursor + vigilancePairsPerLevel).map(function(r){ return r.url; });
        fCursor += vigilancePairsPerLevel;

        var fillerSingles = shuffledFillers.slice(fCursor, fCursor + fillerSinglesPerLevel).map(function(r){ return r.url; });
        fCursor += fillerSinglesPerLevel;

        levels[levelKey] = {
            targets: levelTargets,
            fillers: fillerSingles.concat(vigilanceSources),
            vigilance: vigilanceSources
        };
    });

    manifestData.levels = levels;
    availableLevels = levelKeys.slice();
    allImagesCatalog = [];
    availableLevels.forEach(function(levelKey){
        var level = levels[levelKey];
        allImagesCatalog = allImagesCatalog.concat(level.targets, level.fillers, level.vigilance);
    });
    return levels;
}

function ensureImagesLoaded(){
    if (!imageLoadPromise){
        imageLoadPromise = loadManifests().then(function(payload){
            var registry = buildGlobalRegistry(payload.targetManifest, payload.fillerManifest);
            manifestData = {
                registry: registry,
                levels: {},
                source: {
                    targetManifest: payload.targetManifest.sourceUrl,
                    fillerManifest: payload.fillerManifest.sourceUrl
                }
            };
            pretestImages = registry.pretest.slice();
            availableLevels = [];
            allImagesCatalog = registry.targets.map(function(r){ return r.url; }).concat(registry.fillers.map(function(r){ return r.url; }));
            console.log("Loaded manifests:", registry.targets.length, "targets", registry.fillers.length, "fillers");
            return manifestData;
        }).catch(function(err){
            console.error("Failed to load manifests", err);
            manifestData = null;
            pretestImages = [];
            availableLevels = [];
            allImagesCatalog = [];
            return null;
        });
    }
    return imageLoadPromise;
}

async function requireImagesReady(){
    await ensureImagesLoaded();
    if (!manifestData || !manifestData.registry){
        throw new Error("No manifest data loaded");
    }
    return manifestData;
}
