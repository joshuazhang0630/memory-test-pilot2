document.addEventListener('DOMContentLoaded', function(){
	var query = new URLSearchParams(window.location.search);
	var localQaHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
	if (localQaHost && query.get('qa_fast') === '1'){
		devFastMode = true;
		devPretrainUniqueCount = 2;
		devPretrainTotalCount = 4;
		devLevelTrialCount = 4;
	}
	enforceDesktopRequirement();
	ensureImagesLoaded();
	if (!deviceCompatible){
		return;
	}
	showPreSurvey().catch(function(err){
		console.error('Failed to start pre-survey:', err);
	});
});
