const crypto = require('crypto');
const StreamParser = require('./streamParser');
const { buildSystemPrompt } = require('./promptBuilder');

const geminiLive = require('./geminiLive');
const geminiPro = require('./geminiPro');
const tts = require('./tts');
const imagen = require('./imagen');
const lyria = require('./lyria');
const gcs = require('./gcs');

const OBSERVATION_RE = /<!--OBSERVATION:\s*(.+?)-->/;
const PARAMS_RE = /<!--STORY_PARAMS:(.+?)-->/s;

const IMAGEN_MIN_GAP_MS = 15000;
// NOTE: lastImagenCallTime is intentionally NOT module-level.
// It is set per-session in createSessionState so sessions don't
// throttle each other.

function createSessionState(socket) {
  return {
    sessionId: crypto.randomUUID(),
    socket,
    phase: 'setup',
    storyParams: null,
    setupMethod: null,
    liveSession: null,
    proSession: null,
    parser: new StreamParser(),
    ttsQueue: null,
    lyriaStream: new lyria.LyriaStream(socket),
    observation: null,
    userName: null,
    _greetingNarrationScheduled: false,
    preloadedImage: null,
    storyText: '',
    storyImages: [],
    lastImagenCallTime: 0,  // session-scoped so sessions don't throttle each other
  };
}

// FIX: Add type guard — only try to match if rawText is actually a string.
// geminiLive.js now only passes strings, but this guard is defensive.
function extractStoryParams(rawOutput) {
  if (typeof rawOutput !== 'string') return null;
  const match = rawOutput.match(PARAMS_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractObservation(rawOutput) {
  if (typeof rawOutput !== 'string') return null;
  const match = rawOutput.match(OBSERVATION_RE);
  if (!match) return null;
  return match[1].trim();
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const LIVE_SETUP_PROMPT = `
You are FableGenie's setup genie. Have a short, warm conversation with the user
to understand what kind of story they want.

You need to extract:
1. A setting or world (e.g. "a jungle", "ancient Egypt", "a snowy village")
2. A theme or lesson (e.g. "being kind", "not judging by looks", "patience")
3. Optionally, the user's name

Ask naturally — one question at a time. If they give a full idea in one go, use it.
If they seem unsure, offer two simple choices.

When you have enough (setting + theme minimum), say:
"Perfect — let me summon your fable!"
Then IMMEDIATELY output this on a new line (it will NOT be spoken):
<!--STORY_PARAMS:{"setting":"<setting>","moral":"<theme>","userIdea":"<full idea or null>","userName":"<name or null>"}-->

Maximum 3 conversational turns before committing.
`.trim();

const LIVE_GESTURE_PROMPT = `
Watch the user carefully. They will make one of two gestures.

Thumbs up or open palm = they choose to TRUST.
Cross arms in an X shape = they choose to RUN AWAY.

When you are confident, output ONLY this exact JSON — nothing else:
{"choice": "trust"}
or
{"choice": "run_away"}

Do not speak. Do not explain. Just the JSON. If unsure, wait.
`.trim();

// ─── Session Init ─────────────────────────────────────────────────────────────

async function initSession(socket) {
  const session = createSessionState(socket);
  session.ttsQueue = new tts.TTSPipeline(socket);

  socket.send(JSON.stringify({ type: 'session_id', id: session.sessionId }));

  // ── Parser event wiring ──

  session.parser.on('text', async (text) => {
    // Accumulate full story text (Phase 6)
    session.storyText = (session.storyText || '') + text;

    const activePhases = ['narrating', 'resolving', 'closing'];
    if (activePhases.includes(session.phase)) {
      await session.ttsQueue.enqueue(text, 'narration');
    }
  });


  session.parser.on('moodTag', async (mood) => {
    // Always send mood_change immediately — frontend Web Audio synthesis fires
    // without waiting for lyria-002 (which takes a few seconds to generate)
    socket.send(JSON.stringify({ type: 'mood_change', mood }));

    try {
      if (!session.lyriaStream.isOpen && session.phase === 'narrating') {
        await session.lyriaStream.open();
      }
      await session.lyriaStream.setMood(mood);
    } catch (e) {
      console.warn('[SessionManager] Lyria mood update failed:', e.message);
    }
  });

  session.parser.on('microMoment', (question) => {
    // Route through TTS queue so the question popup is synced with narration audio.
    // Without this, the question appears 20-30s before the narration reaches it.
    console.log(`[SessionManager] [MICRO_MOMENT] tag parsed — enqueueing in TTS pipeline`);
    session.ttsQueue.enqueueMicroMoment(question);
  });

  session.parser.on('branchChoice', async () => {
    // Don't activate gesture mode immediately — the TTS queue is still playing
    // earlier chunks. Instead, enqueue a branch marker so the popup only shows
    // after all preceding audio has been sent to the frontend.
    console.log('[SessionManager] [BRANCH_CHOICE] tag parsed — enqueueing branch marker in TTS pipeline');
    session.ttsQueue.enqueueBranchMarker();
  });

  // ── Internal handler: TTS queue drained up to branch marker ──
  // This is triggered when the TTS pipeline reaches the branch marker item.
  // We listen for it via a WebSocket message the server sends to itself? No —
  // we need to wire this differently. The tts_branch_reached is sent to the
  // *client* who then sends back a branch_ready message after showing the UI.

  session.parser.on('storyEnd', () => {
    session.phase = 'closing';
    // lyriaStream.close() may return undefined when stubbed — guard before .catch()
    const lyriaClose = session.lyriaStream.close();
    if (lyriaClose && typeof lyriaClose.catch === 'function') {
      lyriaClose.catch(() => { });
    }
    console.log('[SessionManager] Story ended, session closing');
  });

  // ── WebSocket message handler ──

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
      console.log(`[WS] Received message of type: ${msg.type}`);
    } catch {
      console.warn('[WS] Received non-JSON message:', raw.toString());
      return;
    }

    if (msg.type === 'resume_session') {
      console.log('[WS] Ignoring resume_session (stale browser cache — do Ctrl+Shift+R)');
    }
    else if (msg.type === 'start_voice_setup' && session.phase === 'setup') {
      await startVoiceSetup(session);
    }
    else if (msg.type === 'webcam_snapshot' && session.phase === 'setup') {
      session.cameraGranted = msg.data !== null;
      session.webcamSnapshot = msg.data; // base64 JPEG or null
      console.log(`[SessionManager] Webcam snapshot received: ${session.cameraGranted ? 'YES' : 'NO'}`);
      // transitionToGreeting is called after story_params
    }
    else if (msg.type === 'story_params' && session.phase === 'setup') {
      session.storyParams = msg.params;
      session.userName = msg.params?.userName || null;
      session.setupMethod = 'ui';
      await transitionToGreeting(session);
    }
    else if (msg.type === 'tts_done') {
      session.ttsQueue.advance(msg.chunkIndex);
    }
    else if (msg.type === 'branch_ready' && session.phase === 'narrating') {
      // Frontend confirmed the branch UI is visible and mic is active.
      // Now activate voice-based branch detection via Gemini Live.
      await activateBranchDetection(session);
    }
    else if (msg.type === 'branch_voice_audio' && session.phase === 'gesture_capture') {
      // Forward branch mic audio to the Live session for interpretation
      if (session.liveSession) {
        session.liveSession.sendAudio(msg.data);
      }
    }
    else if (msg.type === 'webrtc_audio' && session.liveSession) {
      session.liveSession.sendAudio(msg.data);
    }
    else if (msg.type === 'webrtc_video' && session.liveSession) {
      session.liveSession.sendVideo(msg.data);
    }
    else if (msg.type === 'gesture_confirmed') {
      // Manual UI override (tap-to-choose buttons)
      if (session.phase === 'gesture_capture' || session.phase === 'narrating') {
        session.phase = 'gesture_capture'; // normalize
        handleBranchResult(session, msg.branch);
      }
    }
  });

  return session;
}

// ─── Phase 0: Voice Setup ─────────────────────────────────────────────────────

async function startVoiceSetup(session) {
  session.setupMethod = 'voice';
  console.log('[SessionManager] Starting voice setup...');

  try {
    session.liveSession = await geminiLive.create(LIVE_SETUP_PROMPT);
    session.socket.send(JSON.stringify({ type: 'setup_listening' }));

    session.liveSession.onOutput(async (rawText) => {
      if (session.phase !== 'setup') return;
      if (typeof rawText !== 'string') return;

      const params = extractStoryParams(rawText);
      console.log(`[SessionManager] Setup output received (${rawText.length} chars)`);
      if (params) {
        console.log('[SessionManager] Story params extracted from voice:', params);
        session.storyParams = params;
        session.userName = params.userName || null;
        await transitionToGreeting(session);
        return;
      }

      // Strip the params tag before speaking (shouldn't appear in voice output
      // but defensive)
      const spokenText = rawText.replace(PARAMS_RE, '').trim();
      if (spokenText) {
        await session.ttsQueue.enqueue(spokenText, 'setup');
      }
    });

    session.liveSession.onAudio((base64) => {
      session.socket.send(JSON.stringify({ type: 'live_audio', data: base64 }));
    });

    // Prompt the model to start the conversation — without this,
    // it just listens to audio but never initiates.
    await session.liveSession.sendText(
      'Hello! I want to hear a story. Please ask me what kind of story I\'d like.'
    );
  } catch (e) {
    console.error('[SessionManager] Voice setup failed:', e.message);
    // Graceful fallback: tell client to use UI cards instead
    session.socket.send(JSON.stringify({
      type: 'setup_fallback',
      reason: 'Voice setup unavailable. Please select your story below.'
    }));
  }
}

// ─── Phase 1: Greeting ────────────────────────────────────────────────────────

async function transitionToGreeting(session) {
  if (session.phase === 'greeting') return; // guard against double calls
  session.phase = 'greeting';
  session._greetingNarrationScheduled = false;

  // ── FIX: Trigger UI transition & Background Image Generation immediately ──
  // This ensures the theater mode is ready while the host is greeting.
  session.socket.send(JSON.stringify({ type: 'setup_ready' }));

  if (session.storyParams) {
    const settingDesc = session.storyParams.setting || 'magical world';
    const firstScenePrompt = `Opening scene from a ${settingDesc} fable, establishing shot, warm golden light`;
    setImmediate(async () => {
      try {
        console.log('[SessionManager] Pre-generating first story image during greeting...');
        const base64 = await imagen.generateImage(firstScenePrompt);
        if (base64) {
          console.log('[SessionManager] First image ready — storing for narration start');
          session.storyImages.push(base64);
          session.lastImagenCallTime = Date.now();
          // Send immediately so theater mode isn't blank during greeting
          session.socket.send(JSON.stringify({ type: 'image', data: base64 }));
        }
      } catch (e) {
        console.warn('[SessionManager] Pre-generation failed (non-fatal):', e.message);
      }
    });
  }

  const settingLabel = session.storyParams?.setting || 'a magical world';
  const moralLabel = session.storyParams?.moral || 'an important lesson';

  const GREETING_PROMPT_WITH_CAMERA = `
You are FableGenie, a warm and magical AI storyteller.
You have been given a single image of the audience about to hear your story.

Look at the image and:
1. Estimate how many people are present (1, 2, or a group)
2. Estimate the age group (young child 4-7, child 8-12, teen 13+, adult, mixed)
3. Notice ONE warm detail about what you see — a smile, a cozy room, a toy

Then deliver a warm, engaging introduction in this order:
- Greet them personally using what you observed (1 sentence)
- Introduce yourself: "I am FableGenie — I bring stories to life!" (1 sentence)
- Set the scene: "Today, with the help of a tale from ${settingLabel}, we are going 
  to discover something important: ${moralLabel}." (1-2 sentences, make it exciting)
- End with a cliffhanger teaser: hint at the adventure ahead without revealing the plot.

Keep the total greeting to 4-5 sentences. Be warm, magical, and age-appropriate.
Do not mention AI, cameras, machine learning, or technology.

After your greeting, output this silently on a new line (do not speak it):
<!--OBSERVATION: {"viewers": <number>, "ageGroup": "<group>", "detail": "<one warm detail>"}-->
  `.trim();

  const GREETING_PROMPT_NO_CAMERA = `
You are FableGenie, a warm and magical AI storyteller.

Deliver a warm, engaging introduction in this order:
- Greet the audience warmly and make them feel welcome (1 sentence)
- Introduce yourself: "I am FableGenie — I bring stories to life!" (1 sentence)
- Set the scene: "Today, with the help of a tale from ${settingLabel}, we are going 
  to discover something important: ${moralLabel}." (1-2 sentences, make it exciting)
- End with a cliffhanger teaser: hint at the adventure ahead without revealing the plot.

Keep the total greeting to 4-5 sentences. Be warm, magical, and age-appropriate.
Do not mention AI, cameras, machine learning, or technology.
  `.trim();

  const greetingPrompt = session.cameraGranted
    ? GREETING_PROMPT_WITH_CAMERA
    : GREETING_PROMPT_NO_CAMERA;

  // IMPORTANT: Register callbacks BEFORE triggering the greeting
  // otherwise we might miss the first setup_ready trigger.

  let greetingTextAccumulated = '';
  session._setupReadySent = false;

  const onOutput = async (rawText) => {
    if (session.phase !== 'greeting') return;
    if (typeof rawText !== 'string') return;

    greetingTextAccumulated += rawText;
    const obs = extractObservation(greetingTextAccumulated);
    if (obs && !session.observation) {
      session.observation = obs;
      console.log(`[SessionManager] Observation stored:`, obs);
    }

    const spokenText = rawText.replace(OBSERVATION_RE, '').trim();
    if (spokenText) {
      console.log(`[GeminiLive] Audio chunk received for: "${spokenText.substring(0, 30)}..."`);
    }
  };

  const onAudio = (base64) => {
    session.socket.send(JSON.stringify({ type: 'live_audio', data: base64 }));
  };

  // One-time guard using a closure-local boolean.
  // Do NOT rely on session.phase here — the Live model sometimes sends
  // turnComplete twice for a single response, and the second fire can
  // race with the setTimeout in a way that phase hasn't updated yet.
  let greetingDone = false;

  const onTurnComplete = async () => {
    if (greetingDone) {
      console.log('[Phase1] Duplicate turnComplete ignored');
      return;
    }
    greetingDone = true;

    console.log('[Phase1] Greeting turnComplete fired');
    console.log('[Phase1] Scheduling narration in 3s...');
    setTimeout(() => {
      console.log('[Phase1] Starting narration now');
      startNarration(session);
    }, 3000);
  };

  try {
    if (!session.liveSession) {
      session.liveSession = await geminiLive.create(greetingPrompt);
    } else {
      await session.liveSession.swapSystemPrompt(greetingPrompt);
    }

    // Now register them
    session.liveSession.onOutput(onOutput);
    session.liveSession.onAudio(onAudio);
    session.liveSession.onTurnComplete(onTurnComplete);

    if (session.cameraGranted && session.webcamSnapshot) {
      await session.liveSession.sendImage(session.webcamSnapshot);
    }
  } catch (e) {
    console.error('[SessionManager] Greeting session init failed:', e.message);
    await startNarration(session);
    return;
  }

  // Trigger the greeting
  await session.liveSession.sendText('Please greet the audience now.');
}

// ─── Phase 2: Narration ───────────────────────────────────────────────────────

async function startNarration(session) {
  if (session.phase === 'narrating') return;
  session.phase = 'narrating';
  console.log('[SessionManager] Starting narration phase...');

  // Tell frontend to transition from greeting host to story illustration view
  session.socket.send(JSON.stringify({ type: 'narration_started' }));

  if (!session.storyParams) {
    console.warn('[SessionManager] No storyParams set — using defaults');
    session.storyParams = {
      setting: 'an African savanna',
      moral: 'trust must be earned',
      userIdea: null,
      userName: session.userName
    };
  }

  // Give TTS pipeline the story context so imagePrompter can generate
  // scene-appropriate illustrations using the setting, not just raw chunk text.
  session.ttsQueue.storyContext = {
    setting: session.storyParams.setting,
    moral: session.storyParams.moral,
    userIdea: session.storyParams.userIdea
  };

  let sysPrompt;
  try {
    sysPrompt = buildSystemPrompt({
      ...session.storyParams,
      userName: session.userName
    });
  } catch (e) {
    console.error('[SessionManager] buildSystemPrompt failed:', e.message);
    return;
  }

  try {
    session.proSession = await geminiPro.create(sysPrompt);
  } catch (e) {
    console.error('[SessionManager] Gemini Pro init failed:', e.message);
    return;
  }

  session.proSession.onChunk((chunk) => {
    session.parser.feed(chunk);
  });

  try {
    await session.proSession.generateTurn('Begin the fable.');
  } catch (e) {
    console.error('[SessionManager] generateTurn failed:', e.message);
  }
}

// ─── Phase 3: Voice Branch Detection ─────────────────────────────────────────

async function activateBranchDetection(session) {
  session.phase = 'gesture_capture';
  console.log('[SessionManager] Activating voice-based branch detection...');

  try {
    if (!session.liveSession) {
      session.liveSession = await geminiLive.create(LIVE_GESTURE_PROMPT);
    } else {
      await session.liveSession.swapSystemPrompt(LIVE_GESTURE_PROMPT);
    }

    session.liveSession.onOutput((raw) => {
      if (session.phase !== 'gesture_capture') return;
      if (typeof raw !== 'string') return;
      try {
        const res = JSON.parse(raw.trim());
        if (res.choice === 'trust' || res.choice === 'run_away') {
          console.log(`[SessionManager] Voice branch confirmed: ${res.choice}`);
          session.socket.send(JSON.stringify({ type: 'gesture_confirmed', branch: res.choice }));
          handleBranchResult(session, res.choice);
        }
      } catch (e) { /* not JSON yet — partial output, wait for more */ }
    });

    session.liveSession.onAudio((base64) => {
      // Gemini Live might speak in gesture mode — forward audio if it does
      session.socket.send(JSON.stringify({ type: 'live_audio', data: base64 }));
    });

    // Send a text prompt to prime the model
    await session.liveSession.sendText(
      'The listener is about to make a choice. Listen to their voice. ' +
      'They will either say "trust" (or similar positive words) or "run away" (or similar escape words). ' +
      'Output only the JSON when you detect their choice.'
    );
  } catch (e) {
    console.error('[SessionManager] Branch detection init failed:', e.message);
    // Voice failed — frontend buttons still work as fallback
    session.socket.send(JSON.stringify({ type: 'branch_voice_failed' }));
  }
}

// ─── Phase 4: Branch Resolution ──────────────────────────────────────────────

async function handleBranchResult(session, branch) {
  if (session.phase !== 'gesture_capture') return;
  session.phase = 'resolving';
  console.log(`[SessionManager] Branch chosen: ${branch}`);

  // Always confirm to frontend so overlay dismisses and mic stops
  session.socket.send(JSON.stringify({ type: 'gesture_confirmed', branch }));

  const videoFile = branch === 'trust'
    ? 'trust_resolution.mp4'
    : 'run_away_resolution.mp4';

  try {
    const videoUrl = await gcs.getSignedUrl(videoFile);
    if (videoUrl) {
      session.socket.send(JSON.stringify({ type: 'branch_video', url: videoUrl }));
    }
  } catch (e) {
    console.warn('[SessionManager] GCS video unavailable, falling back to slideshow:', e.message);
    session.socket.send(JSON.stringify({ type: 'video_unavailable' }));
  }

  if (session.proSession) {
    try {
      await session.proSession.generateTurn(`The listener chose: ${branch}`);
    } catch (e) {
      console.error('[SessionManager] Resolution generation failed:', e.message);
    }
  }
}

module.exports = { initSession };