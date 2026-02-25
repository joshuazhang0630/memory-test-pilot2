/* prolific edition
- changed the image set from default to mixed visimages
- modified some variables to suit this experiment better
- added code to feed data into a google sheet via apps script
- added a new mark button to support mobile use
- fixed not allowing continuation upon pressing C while on break
- added splash screens for starting and ending the experiment
- multiple bug fixes

*************** Script by Wilma A. Bainbridge, 2016 ***********************

Updated August 26, 2020: Minor updates:
- Now records responses during fixation
- Fixed bug not showing "goodbye" message
- Uses different (more stable) variable to determine experiment trial length
- Participants now have to press "R" to begin, to ensure correct window focus
----------------------

This script was generated to help you run your memorability experiment based on the parameters you want. I hope this is useful to you! If you use the memorability scores or this script in any of your work, please cite: 

***

I've streamlined how the experiments are run here in comparison to the original Isola et al., 2011 study. This means there are some differences for the sake of making this easier to handle. Major differences include:

- Participants can no longer pause, exit, and start again later (since you'd need to maintain a database of their information somewhere!)
- Breaks are fixed time - participants currently can't continue on their own (because of how Javascript's setTimeout works)
- There is no more practice run. Feel free to make a mini experiment to use as a practice run.
- There is no feedback for button presses.

The output you will get are four variables:
 1. imseq: The order of image files shown to participants. Make sure you have no duplicate file names!! (Even if they're in different directories.)
 2. imtypeseq: The order of trial types.
 		0 = Fixation trial
 		1 = First presentation of a target image
 		2 = Second presentation (target repeat) of a target image
 		3 = First presentation of a filler image
 		4 = Second presentation (vigilance repeat) of a filler image
 3. perfseq: The order of participant behavior for each trial.
 		11 = hit
 		12 = miss
 		13 = false alarm
 		14 = correct rejection
 4. ending: Where the participant ended the study. If they finished, it will be set to "completed". If they failed, it will be set to "failed@" and the percentage of trials completed. If they stopped in the middle, it will be blank (but you will know the number of trials completed by the other variables).
 
One thing to keep in mind is that the most complex part of this script is optimizing the number of targets, fillers, timing, etc to maximize number of memorability scores and minimize the cost of the experiment. I have a beginning formula here that will give a good estimate but there may be more complicated designs you could imagine implementing (for example, adding more vigilance repeats or more target repeats dynamically and intelligently if there are not enough fillers). Feel free to try your hand at this -- you could even hard-code the image sequence yourself here instead of having it automatically calculated if you want complete control over everything!

Also keep in mind that these scripts don't necessarily account for human error. You may need to get more hits than the # calculated because people will often fail / quit in the middle.

Lastly, this script can be used as-is with Amazon Mechanical Turk, but you will have to implement your own server-side saving mechanism if you want to host it on your own website. The main values to save in the database can be find in the hidden input tags near the end of this script. If you'd like a tutorial on this, contact me and I'll write one up for people to use.

Let me know if you'd like anything added / changed: brainbridgelab@gmail.com. I will not be very actively updating these scripts, but if I get enough requests for a feature or change, I will likely implement it!

Additional 2024 updates:
- Added modern splash, instruction, and practice flow with pretrain functionality
- Added inline performance feedback overlays
- Modernized styling and mobile-friendly controls while keeping Bainbridge core logic intact
*/


var fixation_address = "http://www.wilmabainbridge.com/datasets/memorabilitycollector/fixation.jpg";
var targetManifestUrl = "https://ivcl.jiangsn.com/visPilot2Dataset/target/manifest.json";
var fillerManifestUrl = "https://ivcl.jiangsn.com/visPilot2Dataset/filler/manifest.json";
var studyVersion = "pilot2-v1";
var studySalt = "pilot2-fixed-pools";
var activeLevelCount = 2;
var images = [];
var allImagesCatalog = [];
var imageLoadPromise = null;
var manifestData = null;
var pretestImages = [];
var availableLevels = [];
var completedLevels = [];
var currentLevelKey = "";
var sessionImagesCatalog = [];
var targetProportion = 0.30;
var complexityPair = [];
var preSurveyResponses = {
    workerId: "",
    takenBefore: "",
    gender: "",
    genderSelf: "",
    age: "",
    education: "",
    complexVizDesc: "",
    complexVizLink: "",
    complexityChoice: "",
    complexityImageA: "",
    complexityImageB: ""
};
var postSurveyResponses = {
    rememberedImage: "",
    rememberFeaturesA: "",
    rememberFeaturesB: "",
    studyComments: ""
};
var experimentCompleted = false;
var postSurveyVisible = false;
var endingStatus = "";
var stopAfterLevel = "";
var stimtime = 2000; // in milliseconds
var isi = 1200; // in milliseconds
var levelTrialCount = 120; // fixed presentations per level
var targetRepeatDelayMin = 91;
var targetRepeatDelayMax = 109;
var vigilanceRepeatMaxGap = 7;
var keytoWatch = "space"; // use space bar for responses
var subsperim = 40; // how many subjects you want per image
var payperhour = 5; // how much money you want to pay per hour
var vigilancecutoff = 10; // the number of vigilances they're allowed to fail before being booted
var facutoff = 20; // the number of false alarms they're allowed to make before being booted
var timeBetweenBreaks = 300; // in seconds
var maxBreakTime = 15; // in seconds 

// text set by the experimenter
var failuretext = "<h2 class='section-title'>Session Halted</h2><p>You exceeded the permitted error rate. Please submit the session to record participation.</p>";
var donetext = "<h2 class='section-title'>Session Complete</h2><p>Thank you for your diligence. You may now submit the session for credit.</p>";

var deviceCompatible = true;
var totalExperimentDuration = 0;
var experimentStartTimestamp = null;
var timerInterval = null;
var breakCountdownInterval = null;
var breakTimeRemaining = 0;
var breakResumeTimeout = null;

// Pretrain variables
var pretrainImages = []; // Will store URLs of images used for pretrain
var pretrainSequence = []; // Full pretrain sequence with repeats
var pretrainTypeSequence = []; // Type of each pretrain trial
var pretrainPerfSequence = []; // Performance for pretrain

// Practice pass criteria (tweak as needed)
var pretrainRequiredHits = 2;
var pretrainMaxFalseAlarms = 1;
var pretrainFailCount = 0;
var pretrainMaxAttempts = 2;
var inPretrainMode = false;
var pretrainImCount = -1;
var pretrainHits = 0;
var pretrainMisses = 0;
var pretrainFalseAlarms = 0;
var pretrainCorrectRejections = 0;

// global variables that are calculated later based on parameters
var numfoils = 0;
var numtargets = 0;
var numtotalsubs = 0;
var experimentlength = 0;
var paypersub = 0;
var totalpay = 0;
var trialsBetweenBreaks = 0;

// full image sequence variables (these are the whole stream, with fixations built in)
// deal with these for when running the experiment
var fullsequence = []; // the sequence of everything (images plus fixation)
var timesequence = []; // the sequence of the timings
var typesequence = []; // the sequence of the image types
var perfsequence = []; // the sequence of the performance
var breakCounter = 0;
var onBreak = false;

// image-only sequence variables (the ordering without fixation or anything extra you add in)
// deal with these when designing the stimulus presentation
var imtypeseq = []; // the sequence of the image types
var allimgseq = []; // the sequence of all the images
var performanceseq = []; // the sequence of performance
var imCount = -1; // trial number that is being shown. Starts from -1 because of setTimeOut quirks

// tracking performance (to determine if they can continue)
var vigilancefails = 0;
var falsealarmcounts = 0;
var kickedOut = 0;

// output variables
var imgstring = "";
var imtypestring = "";
var perfstring = "";
var trialEventRows = [];

// Dev/test helpers (set in console)
var devFastMode = false;
var devPretrainUniqueCount = 1;
var devPretrainTotalCount = 1;
var devLevelTrialCount = 4;

// ID constants for image type
const FIXATION = 0;
const TARGET = 1;
const REPEAT = 2; // target repeat
const FILLER = 3;
const VIGILANCE = 4; // vigilant repeat

// ID constants for performance
const HIT = 11;
const MISS = 12;
const FALSEALARM = 13;
const CORRECTREJECTION = 14;

// Initialize - show splash screen first
var pid = '';
