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
        // Animate Host Appearing
        setTimeout(() => {
          const host = document.getElementById('ai-host-container');
          if (host) host.classList.add('visible');
        }, 500);
        console.log('[WS] Theater mode activated');
        break;

      case 'setup_fallback':
        // Server couldn't do voice setup — show UI cards
        if (voiceStatus) voiceStatus.classList.add('hidden');
        console.warn('[WS] Voice setup fallback:', msg.reason);
        break;

      case 'tts_audio':
        // Host speaking animation
        const host = document.getElementById('ai-host-container');
        if (host) host.classList.add('speaking');
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
          // Hide host when cinematic video plays
          const hostPanel = document.getElementById('ai-host-container');
          if (hostPanel) hostPanel.classList.remove('visible');
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
      const host = document.getElementById('ai-host-container');
      if (host) host.classList.remove('speaking');
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

// ─── Randomizer Helpers ────────────────────────────────────────────────────────

function pickRandomOption(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return null;
  const options = Array.from(select.querySelectorAll('option'))
    .filter(opt => opt.value !== 'random');
  const randomOpt = options[Math.floor(Math.random() * options.length)];
  return randomOpt ? randomOpt.value : null;
}

// ─── Media Stream Manager (WebRTC) ─────────────────────────────────────────────

class MediaStreamManager {
  constructor() {
    this.stream = null;
    this.audioContext = null;
    this.processor = null;
    this.videoInterval = null;
    this.isCapturing = false;
    this.videoTrack = null;
    // For video frame capture
    this.captureVideo = document.createElement('video');
    this.captureVideo.setAttribute('autoplay', '');
    this.captureVideo.setAttribute('muted', '');
    this.captureVideo.setAttribute('playsinline', '');
    this.captureCanvas = document.createElement('canvas');
  }

  async requestPermissions() {
    try {
      console.log('[Media] Requesting permissions (mic + camera)...');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 640, height: 480, frameRate: 15 }
      });
      console.log('[Media] Permissions GRANTED');
      
      this.videoTrack = this.stream.getVideoTracks()[0];
      this.captureVideo.srcObject = this.stream;
      await this.captureVideo.play();
      
      return true;
    } catch (e) {
      console.error('[Media] Permission FAILED:', e);
      return false;
    }
  }

  startCapture() {
    if (!this.stream || this.isCapturing) return;
    this.isCapturing = true;
    console.log('[Media] Starting capture streams...');

    try {
      // Audio Capture & Resampling (16kHz PCM)
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      
      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'webrtc_audio', data: base64 }));
        }
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      // Video Frame Capture (JPEG @ ~2 FPS)
      this.videoInterval = setInterval(() => {
        if (!this.isCapturing) return;
        try {
          this.captureCanvas.width = 640;
          this.captureCanvas.height = 480;
          const ctx = this.captureCanvas.getContext('2d');
          ctx.drawImage(this.captureVideo, 0, 0, 640, 480);
          const base64 = this.captureCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'webrtc_video', data: base64 }));
          }
        } catch (e) {
          console.warn('[Media] Video frame failed:', e);
        }
      }, 500);
      
      console.log('[Media] Capture streams ACTIVE');
    } catch (e) {
      console.error('[Media] startCapture failed:', e);
    }
  }

  stopCapture() {
    console.log('[Media] Stopping capture');
    this.isCapturing = false;
    if (this.videoInterval) clearInterval(this.videoInterval);
    if (this.processor) this.processor.disconnect();
    if (this.audioContext) this.audioContext.close();
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
  }
}

const mediaManager = new MediaStreamManager();

// ─── UI Events ────────────────────────────────────────────────────────────────

// Resume AudioContext on first user interaction (browser autoplay policy)
document.body.addEventListener('click', () => {
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}, { once: true });

if (btnVoiceSetup) {
  btnVoiceSetup.addEventListener('click', async () => {
    if (audioContext.state === 'suspended') await audioContext.resume();
    const ok = await mediaManager.requestPermissions();
    if (!ok) {
      alert('Microphone and Camera access is needed for the Genie to see and hear you.');
      return;
    }
    mediaManager.startCapture();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'start_voice_setup' }));
    }
  });
}

if (btnUiSetup) {
  btnUiSetup.addEventListener('click', async () => {
    console.log('[UI] Begin the fable clicked');
    if (audioContext.state === 'suspended') await audioContext.resume();
    if (!selectSetting || !selectMoral) return;

    const settingValue = selectSetting.value === 'random' ? pickRandomOption('select-setting') : selectSetting.value;
    const moralValue = selectMoral.value === 'random' ? pickRandomOption('select-moral') : selectMoral.value;
    console.log(`[UI] Chosen params: setting=${settingValue}, moral=${moralValue}`);

    const ok = await mediaManager.requestPermissions();
    if (!ok) {
      alert('Microphone and Camera access is needed for the Genie to see and hear you.');
      return;
    }
    mediaManager.startCapture();

    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[UI] Sending story_params to server...');
      ws.send(JSON.stringify({
        type: 'story_params',
        params: {
          setting: settingValue,
          moral: moralValue,
          userIdea: null,
          userName: null
        }
      }));
    } else {
      console.error('[UI] WebSocket NOT open! ReadyState:', ws?.readyState);
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