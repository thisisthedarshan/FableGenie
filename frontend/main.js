const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;

let ws;

// FIX 4: Use sessionStorage instead of localStorage.
// localStorage persists across page reloads and browser sessions, which means
// a stale session ID from a previous run gets sent on reconnect, confusing
// the server. sessionStorage is cleared when the tab closes.
let sessionId = sessionStorage.getItem('fable_session_id') || null;

// FIX 4: intentionalClose flag prevents reconnect loop.
// When the server deliberately closes the connection (e.g. error during init),
// we don't want to silently reconnect in a loop. Only reconnect on unexpected drops.
let intentionalClose = false;

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let nextPlayTime = 0;
let lyriaGainNode = null;
let lyriaAudioSource = null;

// Set up a persistent Lyria gain node so we can fade volume
if (!lyriaGainNode) {
  lyriaGainNode = audioContext.createGain();
  lyriaGainNode.gain.value = 0;
  lyriaGainNode.connect(audioContext.destination);
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

  ws.onopen = () => {
    console.log('[WS] Connected');
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {

      case 'session_id':
        sessionId = msg.id;
        sessionStorage.setItem('fable_session_id', sessionId);
        console.log(`[WS] Session ID: ${sessionId}`);
        break;

      case 'setup_listening':
        if (voiceStatus) voiceStatus.classList.remove('hidden');
        // Real mic streaming: capture via getUserMedia and send as webrtc_audio
        // For now this is a placeholder — the server will time out voice setup
        // and fall back to UI cards if no audio arrives
        console.log('[WS] Voice setup listening...');
        break;

      case 'setup_ready':
        if (setupScreen) setupScreen.classList.remove('active');
        if (theaterMode) theaterMode.classList.add('active');
        console.log('[WS] Theater mode activated');
        break;

      case 'setup_fallback':
        // Server couldn't do voice setup — show UI cards
        if (voiceStatus) voiceStatus.classList.add('hidden');
        console.warn('[WS] Voice setup fallback:', msg.reason);
        break;

      case 'tts_audio':
        await playTTSChunk(msg.data, msg.chunkIndex);
        break;

      case 'image':
        showIllustration(msg.data);
        break;

      case 'lyria_pcm':
        playLyriaPCM(msg.data);
        break;

      case 'branch_video':
        if (videoContainer) {
          videoContainer.src = msg.url;
          videoContainer.classList.remove('hidden');
          videoContainer.play().catch(e => console.warn('[Video] Play failed:', e));
        }
        break;

      case 'video_unavailable':
        // Imagen slideshow fallback is handled server-side via image events
        console.log('[WS] Video unavailable — Imagen slideshow mode');
        break;

      case 'micro_moment':
        if (microMomentText) microMomentText.textContent = msg.question;
        if (microMomentBubble) {
          microMomentBubble.classList.remove('hidden');
          setTimeout(() => microMomentBubble.classList.add('hidden'), 5000);
        }
        break;

      case 'gesture_prompt':
        if (gestureOverlay) gestureOverlay.classList.remove('hidden');
        break;

      case 'gesture_confirmed':
        if (gestureOverlay) gestureOverlay.classList.add('hidden');
        break;

      default:
        console.log('[WS] Unknown message type:', msg.type);
    }
  };

  ws.onerror = (err) => {
    console.error('[WS] WebSocket error:', err);
  };

  ws.onclose = (event) => {
    if (intentionalClose) {
      console.log('[WS] Connection closed intentionally');
      return;
    }
    console.warn(`[WS] Connection lost (code: ${event.code}). Retrying in 1.5s...`);
    setTimeout(connect, 1500);
  };
}

// ─── TTS Playback ─────────────────────────────────────────────────────────────

async function playTTSChunk(base64Data, chunkIndex) {
  // Resume AudioContext if browser blocked it (requires user gesture)
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  try {
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    const now = audioContext.currentTime;
    const playAt = Math.max(now, nextPlayTime);
    source.start(playAt);
    nextPlayTime = playAt + audioBuffer.duration;

    source.onended = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tts_done', chunkIndex }));
      }
    };
  } catch (e) {
    console.error('[TTS] Playback error:', e);
    // Always advance the queue even on error — otherwise TTS stalls permanently
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tts_done', chunkIndex }));
    }
  }
}

// ─── Illustration Fade-in ─────────────────────────────────────────────────────

function showIllustration(base64Data) {
  if (!imageContainer) return;
  const img = new Image();
  img.onload = () => {
    imageContainer.style.opacity = '0';
    imageContainer.style.backgroundImage = `url(${img.src})`;
    imageContainer.style.transition = 'opacity 0.8s ease-in';
    // Trigger reflow before setting opacity so the transition fires
    void imageContainer.offsetWidth;
    imageContainer.style.opacity = '1';
  };
  img.src = `data:image/jpeg;base64,${base64Data}`;
}

// ─── Lyria PCM Playback ───────────────────────────────────────────────────────

function playLyriaPCM(base64Data) {
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  try {
    const binaryStr = atob(base64Data);
    const buffer = new ArrayBuffer(binaryStr.length);
    const view = new DataView(buffer);
    for (let i = 0; i < binaryStr.length; i++) {
      view.setUint8(i, binaryStr.charCodeAt(i));
    }

    const int16Array = new Int16Array(buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const sampleRate = 48000;
    const channels = 2;
    const frameCount = Math.floor(float32Array.length / channels);

    const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = float32Array[i * channels + ch];
      }
    }

    // Fade out and stop existing Lyria source before starting new one
    if (lyriaAudioSource) {
      try {
        lyriaGainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.5);
        lyriaAudioSource.stop(audioContext.currentTime + 0.5);
      } catch { /* already stopped */ }
    }

    lyriaAudioSource = audioContext.createBufferSource();
    lyriaAudioSource.buffer = audioBuffer;
    lyriaAudioSource.loop = true;
    lyriaAudioSource.connect(lyriaGainNode);

    // Fade in new mood
    lyriaGainNode.gain.cancelScheduledValues(audioContext.currentTime);
    lyriaGainNode.gain.setValueAtTime(0, audioContext.currentTime + 0.5);
    lyriaGainNode.gain.linearRampToValueAtTime(0.2, audioContext.currentTime + 2.5);

    lyriaAudioSource.start(audioContext.currentTime + 0.5);
  } catch (e) {
    console.error('[Lyria] PCM playback error:', e);
  }
}

// ─── UI Events ────────────────────────────────────────────────────────────────

// Resume AudioContext on first user interaction (browser autoplay policy)
document.body.addEventListener('click', () => {
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}, { once: true });

if (btnVoiceSetup) {
  btnVoiceSetup.addEventListener('click', () => {
    if (audioContext.state === 'suspended') audioContext.resume();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'start_voice_setup' }));
    }
  });
}

if (btnUiSetup) {
  btnUiSetup.addEventListener('click', () => {
    if (audioContext.state === 'suspended') audioContext.resume();
    if (!selectSetting || !selectMoral) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'story_params',
        params: {
          setting: selectSetting.value,
          moral: selectMoral.value,
          userIdea: null,
          userName: null
        }
      }));
    }
  });
}

// Mock gesture buttons (HTML: onclick="sendMockGesture('trust')")
window.sendMockGesture = function (branch) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'gesture_confirmed', branch }));
  }
};

// ─── Start ────────────────────────────────────────────────────────────────────

connect();