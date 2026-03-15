const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}`;

let ws;
let sessionId = localStorage.getItem('fable_session_id') || null;
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let nextPlayTime = 0;
let lyriaAudioSource = null;

// UI Elements
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

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to server');
    if (sessionId) {
      // Stub for reconnection
      // ws.send(JSON.stringify({ type: 'reconnect', id: sessionId }));
    }
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    
    switch (msg.type) {
      case 'session_id':
        sessionId = msg.id;
        localStorage.setItem('fable_session_id', sessionId);
        break;

      case 'setup_listening':
        voiceStatus.classList.remove('hidden');
        // A real implementation would capture mic via getUserMedia 
        // and stream WebRTC or base64 chunks back as 'webrtc_audio'
        break;

      case 'setup_ready':
        setupScreen.classList.remove('active');
        theaterMode.classList.add('active');
        break;

      case 'tts_audio':
        await playTTSChunk(msg.data, msg.chunkIndex);
        break;

      case 'image':
        imageContainer.style.backgroundImage = `url(data:image/jpeg;base64,${msg.data})`;
        break;

      case 'lyria_pcm':
        playLyriaPCM(msg.data);
        break;

      case 'branch_video':
        videoContainer.src = msg.url;
        videoContainer.classList.remove('hidden');
        videoContainer.play();
        break;

      case 'video_unavailable':
        // Fallback handled silently by just not showing video
        break;

      case 'micro_moment':
        microMomentText.textContent = msg.question;
        microMomentBubble.classList.remove('hidden');
        setTimeout(() => microMomentBubble.classList.add('hidden'), 4000);
        break;

      case 'gesture_prompt':
        gestureOverlay.classList.remove('hidden');
        break;

      case 'gesture_confirmed':
        gestureOverlay.classList.add('hidden');
        break;
    }
  };

  ws.onclose = () => {
    console.log('Connection lost, retrying in 1.5s...');
    setTimeout(connect, 1500);
  };
}

// Play overlapping TTS
async function playTTSChunk(base64Data, chunkIndex) {
  try {
    const binaryStr = atob(base64Data);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    
    const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
    
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    // Prevent immediate overlap by scheduling
    const currentTime = audioContext.currentTime;
    const playAt = Math.max(currentTime, nextPlayTime);
    
    source.start(playAt);
    nextPlayTime = playAt + audioBuffer.duration;

    source.onended = () => {
      if(ws && ws.readyState === WebSocket.OPEN) {
         ws.send(JSON.stringify({ type: 'tts_done', chunkIndex }));
      }
    };
  } catch (e) {
    console.error('Error playing TTS chunk:', e);
    // Tell server we're done so it advances anyway
    if(ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'tts_done', chunkIndex }));
    }
  }
}

// Decode raw PCM from Lyria
async function playLyriaPCM(base64Data) {
   // Decode base64 to binary
   const binaryString = atob(base64Data);
   const len = binaryString.length;
   
   // It's 16-bit PCM, so divide total bytes by 2
   const buffer = new ArrayBuffer(len);
   const view = new DataView(buffer);
   
   for (let i = 0; i < len; i++) {
     view.setUint8(i, binaryString.charCodeAt(i));
   }
   
   // Create Int16Array from the buffer
   const int16Array = new Int16Array(buffer);
   
   // Convert to Float32 Array for WebAudio API
   const float32Array = new Float32Array(int16Array.length);
   for (let i = 0; i < int16Array.length; i++) {
     float32Array[i] = int16Array[i] / 32768.0; 
   }

   const sampleRate = 48000;
   const channels = 2; // Stereo
   const frameCount = float32Array.length / channels;
   
   try {
     const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRate);
     
     // De-interleave channel data
     for (let channel = 0; channel < channels; channel++) {
       const nowBuffering = audioBuffer.getChannelData(channel);
       for (let i = 0; i < frameCount; i++) {
          nowBuffering[i] = float32Array[i * channels + channel];
       }
     }
     
     // Stop previous loop if running
     if (lyriaAudioSource) {
         lyriaAudioSource.stop();
     }

     lyriaAudioSource = audioContext.createBufferSource();
     lyriaAudioSource.buffer = audioBuffer;
     lyriaAudioSource.loop = true;
     
     // Add a slight gain fade-in to make transitions smoother
     const gainNode = audioContext.createGain();
     gainNode.gain.setValueAtTime(0, audioContext.currentTime);
     gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 2); // 50% volume for background
     
     lyriaAudioSource.connect(gainNode);
     gainNode.connect(audioContext.destination);
     
     lyriaAudioSource.start();

   } catch(e) {
     console.error('Error playing Lyria PCM', e);
   }
}

// Connect manually if audio context requires user interaction
document.body.addEventListener('click', () => {
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}, { once: true });


// UI Events
btnVoiceSetup.addEventListener('click', () => {
  if (audioContext.state === 'suspended') audioContext.resume();
  ws.send(JSON.stringify({ type: 'start_voice_setup' }));
});

btnUiSetup.addEventListener('click', () => {
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = {
    setting: selectSetting.value,
    moral: selectMoral.value,
    userIdea: null,
    userName: null
  };
  ws.send(JSON.stringify({ type: 'story_params', params }));
});

// Exposed globally for the gesture mock buttons in HTML
window.sendMockGesture = function(branch) {
  if(ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'gesture_confirmed', branch }));
  }
};

connect();
