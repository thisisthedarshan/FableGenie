const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;

let ws;
let sessionId = sessionStorage.getItem('fable_session_id') || null;
let intentionalClose = false;
let storyStarted = false;
let narrationStarted = false;

// AudioContext created lazily on first user gesture — avoids browser autoplay block
let audioContext = null;
let nextTTSPlayTime = 0;
let nextLivePlayTime = 0;
let lyriaGainNode = null;
let lyriaAudioSource = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    lyriaGainNode = audioContext.createGain();
    lyriaGainNode.gain.value = 0;
    lyriaGainNode.connect(audioContext.destination);
  }
  return audioContext;
}

// ─── UI Elements ──────────────────────────────────────────────────────────────

const setupScreen = document.getElementById('setup-screen');
const theaterMode = document.getElementById('theater-mode');
const btnVoiceSetup = document.getElementById('btn-voice-setup');
const btnUiSetup = document.getElementById('btn-ui-setup');
const selectSetting = document.getElementById('select-setting');
const selectMoral = document.getElementById('select-moral');
const voiceStatus = document.getElementById('voice-status');
const imageContainer = document.getElementById('image-container');
const videoContainer = document.getElementById('video-container');
const microMomentBubble = document.getElementById('micro-moment-bubble');
const microMomentText = document.getElementById('micro-moment-text');
const gestureOverlay = document.getElementById('gesture-overlay');

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  intentionalClose = false;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => console.log('[WS] Connected');

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.type) {

      case 'session_id':
        sessionId = msg.id;
        sessionStorage.setItem('fable_session_id', sessionId);
        console.log(`[WS] Session ID: ${sessionId}`);
        break;

      case 'setup_listening':
        if (voiceStatus) voiceStatus.classList.remove('hidden');
        break;

      // ── Theater mode transition ──────────────────────────────────────────
      case 'setup_ready': {
        storyStarted = true;
        // Stop voice setup mic if it was active
        mediaManager.stopCapture();
        // Sections use CSS opacity + .active class — style.display does nothing
        if (setupScreen) setupScreen.classList.remove('active');
        if (theaterMode) theaterMode.classList.add('active');
        // Show host — MUST remove 'hidden' first (.hidden has display:none !important
        // which overrides everything and blocks the .visible opacity transition)
        setTimeout(() => {
          const host = document.getElementById('ai-host-container');
          if (host) {
            host.classList.remove('hidden');
            void host.offsetWidth; // force reflow so transition plays
            host.classList.add('visible');
          }
        }, 300);
        getAudioContext().resume();
        console.log('[WS] Theater mode activated');
        break;
      }

      case 'setup_fallback':
        if (voiceStatus) voiceStatus.classList.add('hidden');
        console.warn('[WS] Voice setup fallback:', msg.reason);
        break;

      // ── Narration started — fade host out, story illustrations take over ──
      case 'narration_started': {
        // Mark narration as started but do NOT hide the host yet.
        // Host hides on the first TTS chunk so there's no blank screen gap.
        narrationStarted = true;
        console.log('[WS] Narration started — waiting for first TTS chunk to fade host');
        break;
      }

      // ── TTS narration audio ───────────────────────────────────────────────
      case 'tts_audio': {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();
        // Fade host out on the very first TTS chunk that actually plays.
        // This avoids a blank screen gap between narration_started and audio.
        if (narrationStarted) {
          narrationStarted = false; // only do this once
          const host = document.getElementById('ai-host-container');
          if (host && host.classList.contains('visible')) {
            console.log('[UI] Narration audio started — fading out host');
            host.classList.remove('visible');
            // Wait for opacity transition (1s in CSS) then hide from layout
            setTimeout(() => {
              if (!host.classList.contains('visible')) {
                host.classList.add('hidden');
              }
            }, 1000);
          }
        }
        // Pass mimeType so decoder knows if it's raw PCM or encoded audio
        // Pass image data to playback so it shows when audio starts
        await playTTSChunk(msg.audio, msg.image, msg.chunkIndex, msg.mimeType || 'audio/pcm;rate=24000');
        break;
      }

      // ── Story illustration ───────────────────────────────────────────────
      case 'image':
        // FIX: Imagen 3 returns PNG not JPEG — was using wrong MIME type
        showIllustration(msg.data, 'png');
        break;

      case 'mood_change':
        // Fires immediately when a [MUSIC_MOOD:] tag is parsed.
        // Starts Web Audio synthesis while lyria-002 generates in the background.
        // When lyria_pcm arrives it will override this with real audio.
        startAmbience(msg.mood);
        break;

      case 'lyria_pcm':
        // Real Lyria audio from lyria-002 — overrides Web Audio synthesis
        stopAmbience(); // fade out oscillators before playing real audio
        playLyriaPCM(msg.data);
        break;

      // ── Branch resolution video ──────────────────────────────────────────
      case 'branch_video': {
        if (videoContainer) {
          videoContainer.src = msg.url;
          videoContainer.classList.remove('hidden');
          videoContainer.play().catch(e => console.warn('[Video] Play failed:', e));
        }
        break;
      }

      case 'video_unavailable':
        console.log('[WS] No video — Imagen slideshow mode');
        break;

      case 'micro_moment':
        if (microMomentText) microMomentText.textContent = msg.question;
        if (microMomentBubble) {
          microMomentBubble.classList.remove('hidden');
          setTimeout(() => microMomentBubble.classList.add('hidden'), 5000);
        }
        break;

      // ── Branch reached — TTS queue has caught up to [BRANCH_CHOICE] ─────
      case 'tts_branch_reached':
        showBranchOverlay();
        break;

      // ── Gesture overlay — only shows when [BRANCH_CHOICE] fires ──────────
      case 'gesture_prompt':
        if (gestureOverlay) gestureOverlay.classList.remove('hidden');
        break;

      case 'gesture_confirmed':
        hideBranchOverlay();
        break;

      case 'branch_voice_failed':
        // Voice detection failed — buttons still work as fallback
        console.warn('[Branch] Voice detection failed — use tap buttons');
        break;

      // ── Gemini Live audio (greeting phase — raw PCM 24kHz mono) ──────────
      case 'live_audio':
        await playLiveAudioPCM(msg.data, msg.sampleRate || 24000);
        break;

      default:
        console.log('[WS] Unknown message type:', msg.type);
    }
  };

  ws.onerror = (err) => console.error('[WS] Error:', err);

  ws.onclose = (event) => {
    if (intentionalClose) { console.log('[WS] Closed intentionally'); return; }
    if (storyStarted) { console.log('[WS] Lost during story — not reconnecting'); return; }
    console.warn(`[WS] Lost (code ${event.code}). Retrying in 1.5s...`);
    setTimeout(connect, 1500);
  };
}

// ─── TTS Playback ─────────────────────────────────────────────────────────────
// gemini-2.5-flash-preview-tts returns raw 16-bit PCM (audio/pcm;rate=24000).
// This is the same format as Gemini Live audio — NOT WAV/MP3/OGG.
// decodeAudioData only handles encoded formats and will throw on raw PCM.
// Decode manually: base64 → Uint8Array → Int16Array → Float32Array → AudioBuffer.

async function playTTSChunk(audioBase64, imageBase64, chunkIndex, mimeType) {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  try {
    const bytes = base64ToBytes(audioBase64);

    // Parse sample rate from mimeType string e.g. "audio/pcm;rate=24000"
    let sampleRate = 24000; // TTS default
    if (mimeType) {
      const rateMatch = mimeType.match(/rate=(\d+)/);
      if (rateMatch) sampleRate = parseInt(rateMatch[1]);
    }

    // Raw PCM decode: Int16 → Float32
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const playAt = Math.max(now, nextTTSPlayTime);

    // Schedule image display to match audio start
    const delayMs = (playAt - now) * 1000;
    setTimeout(() => {
      if (imageBase64) {
        showIllustration(imageBase64, 'png');
      }
    }, Math.max(0, delayMs));

    source.start(playAt);
    nextTTSPlayTime = playAt + audioBuffer.duration;

    source.onended = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tts_done', chunkIndex }));
      }
    };
    console.log(`[TTS] Playing chunk ${chunkIndex} (${audioBuffer.duration.toFixed(1)}s @ ${sampleRate}Hz)`);
  } catch (e) {
    console.error(`[TTS] Chunk ${chunkIndex} error:`, e.message);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tts_done', chunkIndex }));
    }
  }
}

// ─── Live Audio Playback ──────────────────────────────────────────────────────
// Gemini Live native audio = raw 16-bit PCM mono.
// Must decode manually — decodeAudioData cannot handle raw PCM.

async function playLiveAudioPCM(base64Data, sampleRate) {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  try {
    const bytes = base64ToBytes(base64Data);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const playAt = Math.max(now, nextLivePlayTime);
    source.start(playAt);
    nextLivePlayTime = playAt + audioBuffer.duration;
  } catch (e) {
    console.error('[LiveAudio] Playback error:', e.message);
  }
}

// ─── Lyria PCM Playback ───────────────────────────────────────────────────────
// Lyria outputs raw 16-bit PCM stereo at 48kHz.

function playLyriaPCM(base64Data) {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  try {
    const bytes = base64ToBytes(base64Data);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const channels = 2;
    const frameCount = Math.floor(float32.length / channels);
    const audioBuffer = ctx.createBuffer(channels, frameCount, 48000);
    for (let ch = 0; ch < channels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        data[i] = float32[i * channels + ch];
      }
    }

    if (lyriaAudioSource) {
      try {
        lyriaGainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
        lyriaAudioSource.stop(ctx.currentTime + 0.5);
      } catch { /* already stopped */ }
    }

    lyriaAudioSource = ctx.createBufferSource();
    lyriaAudioSource.buffer = audioBuffer;
    lyriaAudioSource.loop = true;
    lyriaAudioSource.connect(lyriaGainNode);
    lyriaGainNode.gain.cancelScheduledValues(ctx.currentTime);
    lyriaGainNode.gain.setValueAtTime(0, ctx.currentTime + 0.5);
    lyriaGainNode.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 2.5);
    lyriaAudioSource.start(ctx.currentTime + 0.5);
  } catch (e) {
    console.error('[Lyria] Playback error:', e.message);
  }
}

// ─── Web Audio Ambience Synthesis ────────────────────────────────────────────
// Generative ambient music using oscillators — fires immediately on mood change.
// Works without Lyria access. Replaced by real Lyria audio if lyria-002 responds.

const MOOD_PRESETS = {
  // All sine waves — triangle/sawtooth oscillators sound static and buzzy.
  // Layered detuned sines create warmth without harshness.
  peaceful: { baseFreq: 174.6, harmonics: [1, 1.5, 2, 3], gain: 0.04 },
  tense: { baseFreq: 138.6, harmonics: [1, 1.41, 2, 2.83], gain: 0.04 },
  joyful: { baseFreq: 261.6, harmonics: [1, 1.25, 1.5, 2], gain: 0.04 },
  suspenseful: { baseFreq: 110.0, harmonics: [1, 1.5, 2, 2.5], gain: 0.03 },
  triumphant: { baseFreq: 196.0, harmonics: [1, 1.25, 1.5, 2], gain: 0.05 },
};

let ambienceNodes = [];
let ambienceMasterGain = null;

function startAmbience(mood) {
  stopAmbience();
  const ctx = getAudioContext();
  const preset = MOOD_PRESETS[mood] || MOOD_PRESETS.peaceful;

  ambienceMasterGain = ctx.createGain();
  ambienceMasterGain.gain.setValueAtTime(0, ctx.currentTime);
  ambienceMasterGain.gain.linearRampToValueAtTime(preset.gain, ctx.currentTime + 3);
  ambienceMasterGain.connect(ctx.destination);

  preset.harmonics.forEach((ratio, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine'; // always sine — other types buzz
    osc.frequency.value = preset.baseFreq * ratio;
    osc.detune.value = (i * 5) - 2; // slight spread for warmth
    gain.gain.value = 1 / (i + 1);
    osc.connect(gain);
    gain.connect(ambienceMasterGain);
    osc.start();
    ambienceNodes.push(osc, gain);
  });

  console.log(`[Ambience] Web Audio synthesis started: ${mood}`);
}

function stopAmbience() {
  const ctx = getAudioContext();
  if (ambienceMasterGain) {
    ambienceMasterGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
  }
  ambienceNodes.forEach(node => {
    try {
      if (node instanceof OscillatorNode) node.stop(ctx.currentTime + 1.5);
    } catch { /* already stopped */ }
  });
  ambienceNodes = [];
  ambienceMasterGain = null;
}

// ─── Illustration (Crossfade) ─────────────────────────────────────────────
// Double-buffer approach: create a new <img>, fade it in over the old one,
// then remove the old one. Ensures smooth transitions with proper sizing.

function showIllustration(base64Data, mimeType) {
  if (!imageContainer) return;

  const newImg = document.createElement('img');
  newImg.className = 'illustration-layer';
  newImg.alt = 'Story illustration';
  newImg.src = `data:image/${mimeType};base64,${base64Data}`;

  newImg.onload = () => {
    // Append behind current, then crossfade
    imageContainer.appendChild(newImg);
    void newImg.offsetWidth; // force reflow so CSS transition fires
    newImg.classList.add('active');

    // Fade out and remove all older layers after transition completes
    const oldLayers = imageContainer.querySelectorAll('.illustration-layer:not(:last-child)');
    oldLayers.forEach(layer => {
      layer.classList.remove('active');
      setTimeout(() => {
        if (layer.parentNode) layer.parentNode.removeChild(layer);
      }, 1300); // slightly longer than CSS transition (1.2s)
    });

    console.log('[Image] Illustration crossfaded in');
  };
  newImg.onerror = () => console.error('[Image] Failed to load illustration');
}

// ─── Branch Overlay ───────────────────────────────────────────────────────────

let branchMicActive = false;

function showBranchOverlay() {
  if (gestureOverlay) gestureOverlay.classList.remove('hidden');

  // Start mic recording for voice-based branch detection
  startBranchMic();

  // Send branch_ready so the backend activates Gemini Live gesture mode
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'branch_ready' }));
  }

  // Timeout: if no branch chosen in 15s, prompt user to tap
  setTimeout(() => {
    if (gestureOverlay && !gestureOverlay.classList.contains('hidden')) {
      const indicator = document.getElementById('branch-recording-indicator');
      if (indicator) indicator.innerHTML = '<span>Didn\'t catch that — please tap your choice</span>';
    }
  }, 15000);
}

function hideBranchOverlay() {
  if (gestureOverlay) gestureOverlay.classList.add('hidden');
  stopBranchMic();
}

async function startBranchMic() {
  if (branchMicActive) return;
  branchMicActive = true;

  const indicator = document.getElementById('branch-recording-indicator');
  if (indicator) indicator.classList.remove('hidden');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false
    });

    const micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = micCtx.createMediaStreamSource(stream);
    const processor = micCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!branchMicActive) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      }
      const b64 = btoa(String.fromCharCode(...new Uint8Array(i16.buffer)));
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'branch_voice_audio', data: b64 }));
      }
    };

    source.connect(processor);
    processor.connect(micCtx.destination);

    // Store references for cleanup
    window._branchMicStream = stream;
    window._branchMicCtx = micCtx;
    window._branchProcessor = processor;

    console.log('[Branch] Mic recording started for voice choice');
  } catch (e) {
    console.warn('[Branch] Mic unavailable:', e.message);
    branchMicActive = false;
  }
}

function stopBranchMic() {
  branchMicActive = false;
  const indicator = document.getElementById('branch-recording-indicator');
  if (indicator) indicator.classList.add('hidden');

  if (window._branchProcessor) { window._branchProcessor.disconnect(); window._branchProcessor = null; }
  if (window._branchMicCtx) { window._branchMicCtx.close(); window._branchMicCtx = null; }
  if (window._branchMicStream) {
    window._branchMicStream.getTracks().forEach(t => t.stop());
    window._branchMicStream = null;
  }
  console.log('[Branch] Mic recording stopped');
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function base64ToBytes(base64) {
  const str = atob(base64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

// ─── Randomizer ───────────────────────────────────────────────────────────────

function pickRandomOption(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return null;
  const opts = Array.from(select.querySelectorAll('option')).filter(o => o.value !== 'random');
  const pick = opts[Math.floor(Math.random() * opts.length)];
  return pick ? pick.value : null;
}

window.randomizeSelect = function (selectId) {
  const val = pickRandomOption(selectId);
  if (!val) return;
  const select = document.getElementById(selectId);
  select.value = val;
  select.classList.add('shake');
  setTimeout(() => select.classList.remove('shake'), 500);
};

// ─── Media Stream Manager ────────────────────────────────────────────────────

class MediaStreamManager {
  constructor() {
    this.stream = null;
    this.micCtx = null;
    this.processor = null;
    this.videoInterval = null;
    this.captureVideo = document.createElement('video');
    this.captureVideo.setAttribute('autoplay', '');
    this.captureVideo.setAttribute('muted', '');
    this.captureVideo.setAttribute('playsinline', '');
    this.captureCanvas = document.createElement('canvas');
  }

  async requestCameraOptional() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false
      });
      this.captureVideo.srcObject = stream;
      await new Promise(resolve => { this.captureVideo.onloadedmetadata = resolve; });
      await this.captureVideo.play();

      this.captureCanvas.width = 640;
      this.captureCanvas.height = 480;
      this.captureCanvas.getContext('2d').drawImage(this.captureVideo, 0, 0, 640, 480);
      const base64 = this.captureCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];

      stream.getTracks().forEach(t => t.stop());
      this.captureVideo.srcObject = null;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webcam_snapshot', data: base64 }));
        console.log('[Media] Webcam snapshot sent');
      }
      return true;
    } catch (e) {
      console.log('[Media] Camera unavailable:', e.message);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webcam_snapshot', data: null }));
      }
      return false;
    }
  }

  async startMicStreaming() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false
      });
      this.micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = this.micCtx.createMediaStreamSource(this.stream);
      this.processor = this.micCtx.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => {
        const f32 = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
        }
        const b64 = btoa(String.fromCharCode(...new Uint8Array(i16.buffer)));
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'webrtc_audio', data: b64 }));
        }
      };
      source.connect(this.processor);
      this.processor.connect(this.micCtx.destination);
      console.log('[Media] Mic streaming ACTIVE');
    } catch (e) {
      console.warn('[Media] Mic unavailable (non-fatal):', e.message);
    }
  }

  startGestureCapture() {
    if (this.videoInterval) return;
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(stream => {
        this.captureVideo.srcObject = stream;
        this.captureVideo.play();
        this.videoInterval = setInterval(() => {
          this.captureCanvas.width = 320;
          this.captureCanvas.height = 240;
          this.captureCanvas.getContext('2d').drawImage(this.captureVideo, 0, 0, 320, 240);
          const b64 = this.captureCanvas.toDataURL('image/jpeg', 0.5).split(',')[1];
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'webrtc_video', data: b64 }));
          }
        }, 500);
      })
      .catch(e => console.warn('[Media] Gesture camera unavailable:', e.message));
  }

  stopCapture() {
    if (this.videoInterval) { clearInterval(this.videoInterval); this.videoInterval = null; }
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.micCtx) { this.micCtx.close(); this.micCtx = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.captureVideo.srcObject) {
      this.captureVideo.srcObject.getTracks().forEach(t => t.stop());
      this.captureVideo.srcObject = null;
    }
  }
}

const mediaManager = new MediaStreamManager();

// ─── UI Events ────────────────────────────────────────────────────────────────

document.body.addEventListener('click', () => getAudioContext().resume(), { once: true });

if (btnVoiceSetup) {
  btnVoiceSetup.addEventListener('click', async () => {
    getAudioContext().resume();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'start_voice_setup' }));
      // Start streaming mic audio to the backend for Gemini Live
      await mediaManager.startMicStreaming();
      console.log('[Voice Setup] Mic streaming started');
    }
  });
}

if (btnUiSetup) {
  btnUiSetup.addEventListener('click', async () => {
    console.log('[UI] Begin clicked');
    getAudioContext().resume();

    const settingValue = selectSetting?.value === 'random'
      ? pickRandomOption('select-setting') : selectSetting?.value;
    const moralValue = selectMoral?.value === 'random'
      ? pickRandomOption('select-moral') : selectMoral?.value;

    // Lock immediately — prevents reconnect loop from re-sending story_params
    storyStarted = true;
    if (btnUiSetup) {
      btnUiSetup.disabled = true;
      btnUiSetup.textContent = 'Summoning your fable...';
    }

    await mediaManager.requestCameraOptional();

    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`[UI] Sending story_params: ${settingValue} / ${moralValue}`);
      ws.send(JSON.stringify({
        type: 'story_params',
        params: { setting: settingValue, moral: moralValue, userIdea: null, userName: null }
      }));
    } else {
      console.error('[UI] WebSocket not open');
      storyStarted = false;
      if (btnUiSetup) { btnUiSetup.disabled = false; btnUiSetup.textContent = 'Begin the fable →'; }
    }
  });
}

window.sendMockGesture = function (branch) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'gesture_confirmed', branch }));
  }
};

// ─── Start ────────────────────────────────────────────────────────────────────

connect();