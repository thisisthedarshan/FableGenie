const crypto = require('crypto');
const StreamParser = require('./streamParser');
const { buildSystemPrompt } = require('./promptBuilder');

// These will be implemented next
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
    phase: 'setup', // setup, greeting, narrating, qa_interruption, gesture_capture, resolving, closing
    storyParams: null,
    setupMethod: null,
    liveSession: null,
    proSession: null,
    parser: new StreamParser(),
    ttsQueue: null, 
    lyriaStream: new lyria.LyriaStream(socket), // Persistent Lyria stream
    observation: null,
    userName: null,
  };
}

function extractStoryParams(rawOutput) {
  const match = rawOutput.match(PARAMS_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractObservation(rawOutput) {
  const match = rawOutput.match(OBSERVATION_RE);
  if (!match) return null;
  return match[1].trim();
}

const LIVE_SETUP_PROMPT = `
You are FableGenie's setup genie. Your job is to have a short, warm 
conversation with the user to understand what kind of story they want.

You need to extract three things:
1. A setting or world (e.g. "a jungle", "ancient Egypt", "a snowy village")
2. A theme or lesson (e.g. "being kind", "not judging by looks", "patience")
3. Optionally, the user's name

Ask naturally — do not interrogate. One question at a time.
If they give you a full story idea in one go, that's perfect — use it directly.
If they are a young child and seem unsure, offer two simple choices.

When you have enough to build a story (setting + theme minimum),
say: "Perfect — let me summon your fable!" and IMMEDIATELY output this JSON 
on a new line, silently (it will not be spoken):
<!--STORY_PARAMS:{"setting":"<setting>","moral":"<theme>","userIdea":"<full idea if given or null>","userName":"<name if given or null>"}-->

Do not output the JSON until you are ready. Do not mention JSON to the user.
Maximum 3 conversational turns before committing.
`.trim();

const LIVE_GESTURE_PROMPT = `
You are watching the user. They must make a choice with a hand gesture.
If they cross their arms in an X shape, output EXACTLY this JSON:
{"choice": "run_away"}

If they hold out an open palm, output EXACTLY this JSON:
{"choice": "trust"}

Do not say anything else. Just the JSON. If you are unsure, wait.
`.trim();

async function initSession(socket, previousSessionId = null) {
  // Real app might recover state from previousSessionId
  const session = createSessionState(socket);
  session.ttsQueue = new tts.TTSPipeline(socket);

  socket.send(JSON.stringify({ type: 'session_id', id: session.sessionId }));
  
  // Wire up the parser events
  session.parser.on('text', async (text) => {
    if (session.phase === 'narrating' || session.phase === 'resolving' || session.phase === 'closing') {
      await session.ttsQueue.enqueue(text, 'narration');
    }
  });

  session.parser.on('imageTag', async (desc) => {
    const base64 = await imagen.generateImage(desc);
    if (base64) socket.send(JSON.stringify({ type: 'image', data: base64 }));
  });

  session.parser.on('moodTag', async (mood) => {
    if (!session.lyriaStream.isOpen && session.phase === 'narrating') {
       await session.lyriaStream.open();
    }
    await session.lyriaStream.setMood(mood);
  });

  session.parser.on('microMoment', (question) => {
    socket.send(JSON.stringify({ type: 'micro_moment', question }));
  });

  session.parser.on('branchChoice', async () => {
    session.phase = 'gesture_capture';
    socket.send(JSON.stringify({ type: 'gesture_prompt' }));
    
    // Switch live session to gesture mode
    if (session.liveSession) {
      await session.liveSession.swapSystemPrompt(LIVE_GESTURE_PROMPT);
      // Ensure we listen for gesture
      session.liveSession.onOutput((raw) => {
        if (session.phase !== 'gesture_capture') return;
        try {
          const res = JSON.parse(raw);
          if (res.choice === 'trust' || res.choice === 'run_away') {
            socket.send(JSON.stringify({ type: 'gesture_confirmed', branch: res.choice }));
            handleBranchResult(session, res.choice);
          }
        } catch(e) {}
      });
    }
  });

  session.parser.on('storyEnd', () => {
    session.phase = 'closing';
    session.lyriaStream.close();
  });

  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'start_voice_setup' && session.phase === 'setup') {
      await startVoiceSetup(session);
    } 
    else if (msg.type === 'story_params' && session.phase === 'setup') {
      session.storyParams = msg.params;
      session.setupMethod = 'ui';
      await transitionToGreeting(session);
    }
    else if (msg.type === 'tts_done') {
      session.ttsQueue.advance(msg.chunkIndex);
    }
    else if (msg.type === 'webrtc_audio' && session.liveSession) {
      // Forward real-time audio blobs to Gemini Live
      session.liveSession.sendAudio(msg.data);
    }
    else if (msg.type === 'webrtc_video' && session.liveSession) {
      // Forward real-time video blobs to Gemini Live
      session.liveSession.sendVideo(msg.data);
    }
    else if (msg.type === 'gesture_confirmed' && session.phase === 'gesture_capture') {
       // Manual UI override
       handleBranchResult(session, msg.branch);
    }
  });

  return session;
}

async function startVoiceSetup(session) {
  session.setupMethod = 'voice';
  
  session.liveSession = await geminiLive.create(LIVE_SETUP_PROMPT);
  session.socket.send(JSON.stringify({ type: 'setup_listening' }));

  session.liveSession.onOutput(async (rawText) => {
    if (session.phase !== 'setup') return;

    const params = extractStoryParams(rawText);
    if (params) {
      session.storyParams = params;
      session.userName = params.userName;
      await transitionToGreeting(session);
      return;
    }
    
    // No params yet — forward speech to TTS
    const spokenText = rawText.replace(PARAMS_RE, '').trim();
    if (spokenText) await session.ttsQueue.enqueue(spokenText, 'setup');
  });
}

async function transitionToGreeting(session) {
  session.phase = 'greeting';
  session.socket.send(JSON.stringify({ type: 'setup_ready' }));

  const greetingPrompt = `
You can see the user through their webcam. Give them a personalized, 
magical greeting acknowledging their room or appearance.
${session.userName ? `The user's name is ${session.userName}. Use it warmly.` : ''}

After your greeting, silently output this EXACT format so we can save your observation:
<!--OBSERVATION: a short summary of what you saw-->

Do not speak the observation tag.
  `.trim();

  if (!session.liveSession) {
     session.liveSession = await geminiLive.create(greetingPrompt);
  } else {
     await session.liveSession.swapSystemPrompt(greetingPrompt);
  }

  session.liveSession.onOutput(async (rawText) => {
    if (session.phase !== 'greeting') return;

    const obs = extractObservation(rawText);
    if (obs) session.observation = obs;

    const spokenText = rawText.replace(OBSERVATION_RE, '').trim();
    if (spokenText) {
      await session.ttsQueue.enqueue(spokenText, 'greeting');
    }

    // Auto transition to Phase 2 after greeting
    if (obs || rawText.length > 50) { 
       // Start narrative
       setTimeout(() => startNarration(session), 4000); 
    }
  });
}

async function startNarration(session) {
  if (session.phase === 'narrating') return;
  session.phase = 'narrating';

  const sysPrompt = buildSystemPrompt({ 
    ...session.storyParams, 
    userName: session.userName 
  });

  session.proSession = await geminiPro.create(sysPrompt);
  session.proSession.onChunk((chunk) => {
    session.parser.feed(chunk);
  });

  // Start the generation stream
  await session.proSession.generateTurn("Begin the fable.");
}

async function handleBranchResult(session, branch) {
  if (session.phase !== 'gesture_capture') return;
  session.phase = 'resolving';

  // Trigger Veo Video
  try {
    const videoUrl = await gcs.getSignedUrl(branch === 'trust' ? 'trust_resolution.mp4' : 'run_away_resolution.mp4');
    if (videoUrl) {
      session.socket.send(JSON.stringify({ type: 'branch_video', url: videoUrl }));
    }
  } catch (error) {
    console.warn('[SessionManager] Veo video fetch failed, falling back to Imagen slideshow.');
    session.socket.send(JSON.stringify({ type: 'video_unavailable' }));
  }

  // Tell Pro to continue
  await session.proSession.generateTurn(`The listener chose: ${branch}`);
}

module.exports = { initSession };
