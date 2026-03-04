async function showPreSurvey(){
    try {
        await requireImagesReady();
    } catch (e){
        console.error(e);
        var errorView = `
            <section class="card">
                <h1 class="section-title">Unable to load images</h1>
                <p class="lead-text">The image manifest could not be loaded. Please check your network connection and refresh the page.</p>
            </section>
        `;
        document.body.innerHTML = renderShell(errorView);
        return;
    }
    var content = `
        <section class="card compact-card">
            <div id="demographics" class="slide" style="display: block;">
                <form id="pre-survey-form" name="demographics" autocomplete="off">
                    <div id="header-container">
                        <span id="form-header" class="spaced-right">Please tell us a bit about yourself.</span>
                        <span id="why-form">Why?</span>
                        <div id="required-message" style="color: #0099CC">Fields marked with a * are required.</div>
                    </div>
                    <div class="form-element" id="pcid-container">
                        <span class="prompt-text spaced-right "><span style="color: #0099CC">*</span> Please provide your participant ID:</span>
                        <input type="text" id="pcid" name="participant_id" required>
                    </div>
                    <div class="form-element" id="retake-container">
                        <span class="prompt-text" style="color: #0099CC">* </span>
                        <span class="prompt-text spaced-right ">Have you taken this test before?</span>
                        <select id="retake" name="retake" required>
                            <option value=""></option>
                            <option value="no">No</option>
                            <option value="yes">Yes</option>
                        </select>
                    </div>
                    <div class="form-element" id="gender-container">
                        <span class="prompt-text" style="color: #0099CC">* </span>
                        <span class="prompt-text spaced-right ">What is your gender?</span>
                        <input type="checkbox" name="gender" id="gender0" value="man">
                        <label class="multiselect-label" for="gender0">Man</label>
                        <input type="checkbox" name="gender" id="gender1" value="woman">
                        <label class="multiselect-label" for="gender1">Woman</label>
                        <input type="checkbox" name="gender" id="gender2" value="nonbinary">
                        <label class="multiselect-label" for="gender2">Non-binary</label>
                        <input type="checkbox" name="gender" id="gender3" value="--">
                        <label class="multiselect-label" for="gender3">Prefer not to disclose</label>
                        <input type="checkbox" name="gender" id="gender4" value="other">
                        <label class="multiselect-label" for="gender4">Prefer to self-describe</label>
                        <input type="text" id="gendertext" name="gendertext" disabled="disabled">
                        <div id="gender-error" class="small-note" style="color: var(--error); display: none;">
                            Please select at least one option.
                        </div>
                    </div>
                    <div class="form-element" id="age_category-container">
                        <span class="prompt-text" style="color: #0099CC">* </span>
                        <span class="prompt-text spaced-right ">How old are you?</span>
                        <select id="age_category" name="age_category" required>
                            <option value=""></option>
                            <option value="18-25">18-25</option>
                            <option value="26-35">26-35</option>
                            <option value="36-45">36-45</option>
                            <option value="46-55">46-55</option>
                            <option value="Over 55">Over 55</option>
                        </select>
                    </div>
                    <div class="form-element" id="education-container">
                        <span class="prompt-text" style="color: #0099CC">* </span>
                        <span class="prompt-text spaced-right ">What is the highest level of education you have received?</span>
                        <select id="education" name="education" required>
                            <option value=""></option>
                            <option value="Some high-school">Some high-school</option>
                            <option value="College">College</option>
                            <option value="Graduate school">Graduate school</option>
                            <option value="Professional school">Professional school</option>
                            <option value="PhD">PhD</option>
                        </select>
                    </div>
                    <div class="form-element" id="textExperience-container">
                        <span class="prompt-text spaced-right "><span style="color: #0099CC">*</span> Describe the most complex visualization you have ever seen. What it looks like? Having a link to the image will be helpful but this is not absolutely necessary.</span>
                        <textarea id="textExperience" name="textExperience" required></textarea>
                    </div>
                    <div class="action-row">
                        <button type="submit" class="primary-button">Continue to Instructions</button>
                    </div>
                </form>
            </div>
        </section>
    `;
    document.body.innerHTML = renderShell(content);

    var genderSelfToggle = document.getElementById("gender4");
    var genderSelfInput = document.getElementById("gendertext");
    var genderError = document.getElementById("gender-error");
    if (genderSelfToggle && genderSelfInput){
        genderSelfToggle.addEventListener("change", function(){
            genderSelfInput.disabled = !genderSelfToggle.checked;
            if (!genderSelfToggle.checked){
                genderSelfInput.value = "";
            } else {
                genderSelfInput.focus();
            }
        });
    }

    var genderInputs = Array.from(document.querySelectorAll("input[name='gender']"));
    var genderFirstInput = document.getElementById("gender0");
    function updateGenderValidity(){
        var anyChecked = genderInputs.some(function(el){ return el.checked; });
        if (genderFirstInput){
            genderFirstInput.setCustomValidity(anyChecked ? "" : "Please complete this required field.");
        }
        if (genderError){
            genderError.style.display = anyChecked ? "none" : "block";
        }
    }
    genderInputs.forEach(function(input){
        input.addEventListener("change", updateGenderValidity);
    });
    updateGenderValidity();

    var preForm = document.getElementById("pre-survey-form");
    if (preForm){
        setEnglishValidationMessages(preForm);
        preForm.onsubmit = function(e){
            e.preventDefault();
            var genderSelections = Array.from(document.querySelectorAll("input[name='gender']:checked")).map(function(el){
                return el.value;
            });
            if (genderSelections.length === 0){
                updateGenderValidity();
                if (genderFirstInput){
                    genderFirstInput.focus();
                    genderFirstInput.reportValidity();
                }
                var genderContainer = document.getElementById("gender-container");
                if (genderContainer){
                    genderContainer.scrollIntoView({ behavior: "smooth", block: "center" });
                }
                return;
            }
            updateGenderValidity();
            if (!preForm.reportValidity()){
                return;
            }
            pid = (document.getElementById("pcid").value || "").trim();
            preSurveyResponses.workerId = pid;
            preSurveyResponses.takenBefore = document.getElementById("retake").value;
            preSurveyResponses.gender = genderSelections.join("|");
            preSurveyResponses.genderSelf = (document.getElementById("gendertext").value || "").trim();
            preSurveyResponses.age = document.getElementById("age_category").value;
            preSurveyResponses.education = document.getElementById("education").value;
            preSurveyResponses.complexVizDesc = (document.getElementById("textExperience").value || "").trim();
            preSurveyResponses.complexVizLink = "";
            preSurveyResponses.complexityChoice = "";
            preSurveyResponses.complexityImageA = "";
            preSurveyResponses.complexityImageB = "";

            buildPretrainSequence();
            showInstructions();
        };
    }
}

// Show instruction page

function getSessionId(){
    if (!currentSessionId){
        currentSessionId = (pid || "anon") + "-" + Date.now();
    }
    return currentSessionId;
}

function persistTrialCheckpoint(){
    try {
        var payload = {
            session_id: getSessionId(),
            pid: pid || "",
            updated_at: new Date().toISOString(),
            trial_rows_count: (trialEventRows || []).length,
            trial_rows: (trialEventRows || []).slice(-200),
            ending_status: endingStatus || ""
        };
        localStorage.setItem("pilot2_checkpoint_" + getSessionId(), JSON.stringify(payload));
    } catch (e){
        console.warn("checkpoint save failed", e);
    }
}

function validateRows(rows){
    if (!rows || !rows.length){
        return { ok: false, reason: "no_rows" };
    }
    var required = ["event_type", "timestamp_iso", "session_id", "study_version"];
    for (var i = 0; i < rows.length; i++){
        for (var j = 0; j < required.length; j++){
            if (rows[i][required[j]] === undefined || rows[i][required[j]] === null){
                return { ok: false, reason: "missing_field:" + required[j] + "@" + i };
            }
        }
    }
    return { ok: true };
}

function postPayload(appsURL, payload){
    return fetch(appsURL, {
        method: "POST",
        mode: "no-cors",
        keepalive: true,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
    });
}

async function postWithRetries(appsURL, payload, attempts){
    for (var i = 0; i < attempts; i++){
        try {
            await postPayload(appsURL, payload);
            return true;
        } catch (e){
            if (i === attempts - 1){
                console.error("send failed", e);
            }
        }
    }
    try {
        if (navigator.sendBeacon){
            var ok = navigator.sendBeacon(appsURL, new Blob([JSON.stringify(payload)], { type: "application/json" }));
            if (ok){
                return true;
            }
        }
    } catch (e2){
        console.error("beacon failed", e2);
    }
    return false;
}

async function sendToSheets() {
	const form = document.getElementById('form');
    const formData = new FormData(form);
    const appsURL = "https://script.google.com/macros/s/AKfycbxy8Li7LKoIZK30w0ivOeQUqfmWTBWWLfMxBqByQjlWCAkJJPYucQLh7Pp0Vc_Pa3I1jg/exec";

    const baseMeta = {
        user_id: pid,
        participant_id: pid,
        session_id: getSessionId(),
        study_version: studyVersion || "pilot2-v1",
        levels_completed: completedLevels.length,
        stop_after_level: stopAfterLevel || "",
        pre_survey_submitted: preSurveyResponses && preSurveyResponses.workerId ? 1 : 0,
        post_survey_submitted: 1,
        pre_q1: preSurveyResponses.takenBefore || "",
        pre_q2: preSurveyResponses.gender || "",
        pre_q3: preSurveyResponses.age || "",
        pre_q4: preSurveyResponses.education || "",
        pre_q5: preSurveyResponses.complexVizDesc || "",
        post_q1: postSurveyResponses.rememberFeaturesA || "",
        post_q2: postSurveyResponses.rememberFeaturesB || "",
        post_q3: postSurveyResponses.studyComments || "",
        post_q4: "",
        post_q5: "",
        post_q6: "",
        post_q7: "",
        post_q8: ""
    };

    const trialRows = (trialEventRows || []).map(function(row){
        var merged = Object.assign({}, row);
        merged.user_id = baseMeta.user_id;
        merged.participant_id = baseMeta.participant_id;
        merged.session_id = baseMeta.session_id;
        merged.study_version = baseMeta.study_version;
        merged.levels_completed = baseMeta.levels_completed;
        merged.stop_after_level = baseMeta.stop_after_level;
        merged.pre_survey_submitted = baseMeta.pre_survey_submitted;
        merged.post_survey_submitted = 1;
        merged.pre_q1 = baseMeta.pre_q1;
        merged.pre_q2 = baseMeta.pre_q2;
        merged.pre_q3 = baseMeta.pre_q3;
        merged.pre_q4 = baseMeta.pre_q4;
        merged.pre_q5 = baseMeta.pre_q5;
        merged.event_id = merged.event_id || (baseMeta.session_id + ":trial:" + merged.trial_index);
        merged.client_meta_json = JSON.stringify({
            vigilancefails: vigilancefails,
            falsealarmcounts: falsealarmcounts,
            ending: endingStatus || document.getElementById("endingout").value || "",
            source: "trial"
        });
        return merged;
    });

    const summaryEvent = {
        event_type: "session_end",
        event_id: baseMeta.session_id + ":session_end",
        timestamp_iso: new Date().toISOString(),
        user_id: baseMeta.user_id,
        participant_id: baseMeta.participant_id,
        session_id: baseMeta.session_id,
        study_version: baseMeta.study_version,
        level_index: completedLevels.length,
        trial_index: "",
        image_id: "",
        image_url: "",
        trial_type: "",
        is_repeat: "",
        expected_response: "",
        participant_response: "",
        is_correct: "",
        rt_ms: "",
        repeat_lag: "",
        vigilance_flag: "",
        false_alarm_flag: "",
        hit_flag: "",
        miss_flag: "",
        quality_gate_status: kickedOut ? "failed" : "completed",
        quality_gate_reason: kickedOut ? "threshold_exceeded" : "",
        levels_completed: baseMeta.levels_completed,
        stop_after_level: baseMeta.stop_after_level,
        pre_survey_submitted: baseMeta.pre_survey_submitted,
        post_survey_submitted: 1,
        pre_q1: baseMeta.pre_q1,
        pre_q2: baseMeta.pre_q2,
        pre_q3: baseMeta.pre_q3,
        pre_q4: baseMeta.pre_q4,
        pre_q5: baseMeta.pre_q5,
        post_q1: baseMeta.post_q1,
        post_q2: baseMeta.post_q2,
        post_q3: baseMeta.post_q3,
        post_q4: baseMeta.post_q4,
        post_q5: baseMeta.post_q5,
        post_q6: baseMeta.post_q6,
        post_q7: baseMeta.post_q7,
        post_q8: baseMeta.post_q8,
        client_meta_json: JSON.stringify({
            imseq: imgstring,
            imtypeseq: imtypestring,
            perfseq: perfstring,
            ending: endingStatus || document.getElementById("endingout").value || "",
            vigilancefails: vigilancefails,
            falsealarmcounts: falsealarmcounts,
            pre_raw: preSurveyResponses,
            post_raw: postSurveyResponses,
            form_fields: Object.fromEntries(formData.entries())
        })
    };

    const allRows = trialRows.concat([summaryEvent]);
    var check = validateRows(allRows);
    if (!check.ok){
        console.error("payload validation failed", check.reason);
        alert("Submission blocked: " + check.reason + ". Please refresh and retry.");
        return;
    }

    // chunk rows to reduce chance of payload loss
    var chunkSize = 120;
    var okAll = true;
    for (var start = 0; start < allRows.length; start += chunkSize){
        var chunk = allRows.slice(start, start + chunkSize);
        const payload = {
            spreadsheet_id: "1i6SZGswHCEZjhYgxzQae5jjQDFowSl7jnA0IwYYcDVY",
            worksheet_name: "sheet1",
            schema_version: "v2",
            rows: chunk,
            chunk_index: Math.floor(start / chunkSize),
            chunk_total: Math.ceil(allRows.length / chunkSize),
            prolific_id: pid,
            imseq: imgstring,
            imtypeseq: imtypestring,
            perfseq: perfstring,
            ending: endingStatus || document.getElementById("endingout").value || "",
            vigilancefails: vigilancefails,
            falsealarmcounts: falsealarmcounts,
            pre_worker_id: preSurveyResponses.workerId,
            pre_taken_before: preSurveyResponses.takenBefore,
            pre_gender: preSurveyResponses.gender,
            pre_gender_self: preSurveyResponses.genderSelf,
            pre_age: preSurveyResponses.age,
            pre_education: preSurveyResponses.education,
            pre_complex_viz_desc: preSurveyResponses.complexVizDesc,
            post_remember_features_a: postSurveyResponses.rememberFeaturesA,
            post_remember_features_b: postSurveyResponses.rememberFeaturesB,
            post_study_comments: postSurveyResponses.studyComments
        };
        var ok = await postWithRetries(appsURL, payload, 3);
        okAll = okAll && ok;
    }

    persistTrialCheckpoint();
    if (okAll){
        localStorage.removeItem("pilot2_checkpoint_" + getSessionId());
    }
    console.log(okAll ? "Data sent to Google Sheets!" : "Data submission may be partial; checkpoint saved locally.");
}

