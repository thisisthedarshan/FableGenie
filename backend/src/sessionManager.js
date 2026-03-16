const crypto = require('crypto');
const StreamParser = require('./streamParser');
const { buildSystemPrompt } = require('./promptBuilder');

const geminiLive = require('./geminiLive');
const geminiPro = require('./geminiPro');
const tts = require('./tts');
const imagen = require('./imagen');
const lyria = require('./lyria');
const gcs = require('./gcs');

const PARAMS_RE = /<!--STORY_PARAMS:(.+?)-->/s;
const OBSERVATION_RE = /<!--OBSERVATION:\s*(.+?)-->/;

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
    _greetingNarrationScheduled: false, // guard against multiple startNarration calls
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
    const activePhases = ['narrating', 'resolving', 'closing'];
    if (activePhases.includes(session.phase)) {
      await session.ttsQueue.enqueue(text, 'narration');
    }
  });

  session.parser.on('imageTag', async (desc) => {
    try {
      const base64 = await imagen.generateImage(desc);
      if (base64) socket.send(JSON.stringify({ type: 'image', data: base64 }));
    } catch (e) {
      console.warn('[SessionManager] Imagen failed, skipping image:', e.message);
    }
  });

  session.parser.on('moodTag', async (mood) => {
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
    socket.send(JSON.stringify({ type: 'micro_moment', question }));
  });

  session.parser.on('branchChoice', async () => {
    session.phase = 'gesture_capture';
    socket.send(JSON.stringify({ type: 'gesture_prompt' }));

    if (session.liveSession) {
      // Swap to gesture detection mode
      await session.liveSession.swapSystemPrompt(LIVE_GESTURE_PROMPT);
      session.liveSession.onOutput((raw) => {
        if (session.phase !== 'gesture_capture') return;
        if (typeof raw !== 'string') return;
        try {
          const res = JSON.parse(raw.trim());
          if (res.choice === 'trust' || res.choice === 'run_away') {
            console.log(`[SessionManager] Gesture confirmed: ${res.choice}`);
            socket.send(JSON.stringify({ type: 'gesture_confirmed', branch: res.choice }));
            handleBranchResult(session, res.choice);
          }
        } catch (e) { /* not JSON yet, still watching */ }
      });
    }
  });

  session.parser.on('storyEnd', () => {
    session.phase = 'closing';
    session.lyriaStream.close().catch(() => { });
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

    if (msg.type === 'start_voice_setup' && session.phase === 'setup') {
      await startVoiceSetup(session);
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
    else if (msg.type === 'webrtc_audio' && session.liveSession) {
      session.liveSession.sendAudio(msg.data);
    }
    else if (msg.type === 'webrtc_video' && session.liveSession) {
      session.liveSession.sendVideo(msg.data);
    }
    else if (msg.type === 'gesture_confirmed' && session.phase === 'gesture_capture') {
      // Manual UI override (mock gesture buttons)
      handleBranchResult(session, msg.branch);
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

  session.socket.send(JSON.stringify({ type: 'setup_ready' }));
  console.log('[SessionManager] Transitioning to greeting phase...');

  const greetingPrompt = `
You are FableGenie, a warm and magical storyteller for children aged 6–12.
You can see the user through their webcam right now.
Give them a warm, personal greeting (3 sentences maximum).
Mention ONE specific thing you notice about their visible environment.
${session.userName ? `The user's name is ${session.userName}. Use it warmly.` : ''}

After your greeting, output this EXACT line silently (it will NOT be spoken):
<!--OBSERVATION: one sentence describing what you noticed-->

Never speak the observation tag.
  `.trim();

  try {
    if (!session.liveSession) {
      session.liveSession = await geminiLive.create(greetingPrompt);
    } else {
      await session.liveSession.swapSystemPrompt(greetingPrompt);
    }
  } catch (e) {
    console.error('[SessionManager] Greeting session init failed:', e.message);
    // Skip greeting, go straight to narration
    await startNarration(session);
    return;
  }

  // Accumulate all greeting text chunks for observation extraction
  // (the observation tag might come at the end of the full response,
  //  not necessarily in the first chunk)
  let greetingTextAccumulated = '';

  session.liveSession.onOutput(async (rawText) => {
    if (session.phase !== 'greeting') return;
    if (typeof rawText !== 'string') return;

    greetingTextAccumulated += rawText;

    // Try to extract observation from accumulated text
    const obs = extractObservation(greetingTextAccumulated);
    if (obs && !session.observation) {
      session.observation = obs;
      console.log(`[SessionManager] Observation stored: "${obs}"`);
    }

    // Strip the observation tag before sending to TTS
    const spokenText = rawText.replace(OBSERVATION_RE, '').trim();
    if (spokenText) {
      await session.ttsQueue.enqueue(spokenText, 'greeting');
    }
  });

  // FIX 3: Use onTurnComplete to know when the greeting is DONE.
  // This replaces the unreliable rawText.length > 50 heuristic.
  // turnComplete fires once when Gemini finishes its full response.
  session.liveSession.onTurnComplete(async () => {
    if (session.phase !== 'greeting') return;
    if (session._greetingNarrationScheduled) return; // prevent double scheduling
    session._greetingNarrationScheduled = true;

    console.log('[SessionManager] Greeting complete. Starting narration in 3s...');
    // Small delay so the last TTS chunk has time to start playing
    setTimeout(() => startNarration(session), 3000);
  });

  // Kick off the greeting — safe to call now because initialize()
  // has already waited for setupComplete before returning
  await session.liveSession.sendText('Please greet the user now.');
}

// ─── Phase 2: Narration ───────────────────────────────────────────────────────

async function startNarration(session) {
  if (session.phase === 'narrating') return;
  session.phase = 'narrating';
  console.log('[SessionManager] Starting narration phase...');

  if (!session.storyParams) {
    console.warn('[SessionManager] No storyParams set — using defaults');
    session.storyParams = {
      setting: 'an African savanna',
      moral: 'trust must be earned',
      userIdea: null,
      userName: session.userName
    };
  }

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

// ─── Phase 4: Branch Resolution ──────────────────────────────────────────────

async function handleBranchResult(session, branch) {
  if (session.phase !== 'gesture_capture') return;
  session.phase = 'resolving';
  console.log(`[SessionManager] Branch chosen: ${branch}`);

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