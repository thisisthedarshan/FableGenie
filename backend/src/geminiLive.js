const { GoogleGenAI } = require('@google/genai');

let ai = null;
function getAi() {
  if (!ai) {
    ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION
    });
  }
  return ai;
}

// Confirmed working model name (verified via test-genai.js)
const MODEL_NAME = 'gemini-live-2.5-flash-native-audio';

class GeminiLiveSession {
  constructor(initialPrompt) {
    this.systemPrompt = initialPrompt;
    this.session = null;
    this.onOutputCallback = null;
    this.onTurnCompleteCallback = null;
    this._intentionalClose = false;
  }

  async initialize() {
    console.log('[GeminiLive] Initializing live session...');
    this._intentionalClose = false;

    // FIX 1: Wrap in a Promise that only resolves on setupComplete.
    // The SDK resolves live.connect() when the WebSocket connects,
    // but Gemini isn't ready to receive messages until setupComplete fires.
    // Calling sendText() before setupComplete causes the message to be dropped.
    return new Promise(async (resolve, reject) => {
      let setupResolved = false;

      try {
        this.session = await getAi().live.connect({
          model: MODEL_NAME,
          config: {
            systemInstruction: { parts: [{ text: this.systemPrompt }] },
            // Force text responses. The native audio model defaults to audio
            // output — parts arrive as binary blobs with no .text property,
            // so observation/params extraction silently produces nothing.
            // TEXT mode gives us strings we can actually parse.
            responseModalities: ['TEXT']
          },
          callbacks: {
            onmessage: (message) => {
              // Resolve the initialize() promise only when Gemini confirms ready
              if (!setupResolved && message.setupComplete) {
                setupResolved = true;
                console.log('[GeminiLive] Live session ready (setupComplete received)');
                resolve();
              }

              if (message.serverContent) {
                const modelTurn = message.serverContent.modelTurn;

                if (modelTurn && modelTurn.parts && modelTurn.parts.length > 0) {
                  // FIX 2: Only pass TEXT to onOutputCallback — never arrays.
                  // When Gemini responds with audio, parts have no .text property.
                  // Passing the parts array caused rawText.match() to throw TypeError
                  // silently in the async callbacks in sessionManager.js.
                  const text = modelTurn.parts
                    .map(p => p.text)
                    .filter(Boolean)
                    .join('');

                  if (text) {
                    console.log(`[GeminiLive] Text received: "${text.substring(0, 80)}..."`);
                    if (this.onOutputCallback) {
                      this.onOutputCallback(text);
                    }
                  }
                  // Non-text parts (audio) are intentionally ignored here.
                  // Audio output from the Live API requires separate audio stream
                  // handling which is not implemented in this version.
                }

                // FIX 3: Emit turnComplete when Gemini finishes a full response.
                // This replaces the unreliable rawText.length > 50 heuristic.
                if (message.serverContent.turnComplete) {
                  console.log('[GeminiLive] Turn complete');
                  if (this.onTurnCompleteCallback) {
                    this.onTurnCompleteCallback();
                  }
                }
              }
            },

            onerror: (err) => {
              console.error('[GeminiLive] WebSocket error:', err);
              if (!setupResolved) {
                setupResolved = true;
                reject(err);
              }
            },

            onclose: () => {
              if (this._intentionalClose) {
                console.log('[GeminiLive] Session closed (intentional)');
              } else {
                console.warn('[GeminiLive] Session closed unexpectedly');
              }
              if (!setupResolved) {
                setupResolved = true;
                reject(new Error('Gemini Live session closed before setupComplete'));
              }
            }
          }
        });
      } catch (e) {
        if (!setupResolved) {
          setupResolved = true;
          reject(e);
        }
      }
    });
  }

  // Register callback for text output chunks
  onOutput(callback) {
    this.onOutputCallback = callback;
  }

  // Register callback for when a full response turn is complete
  // Use this instead of rawText.length > 50 to know when Gemini finished speaking
  onTurnComplete(callback) {
    this.onTurnCompleteCallback = callback;
  }

  async swapSystemPrompt(newPrompt) {
    console.log('[GeminiLive] Swapping system prompt...');
    this.systemPrompt = newPrompt;
    // Save and clear callbacks — they will be re-registered by the caller
    const prevOutput = this.onOutputCallback;
    const prevTurnComplete = this.onTurnCompleteCallback;
    this.close();
    await this.initialize();
    // Restore callbacks after new session is ready
    // (caller can override these after swapSystemPrompt resolves)
    this.onOutputCallback = prevOutput;
    this.onTurnCompleteCallback = prevTurnComplete;
    console.log('[GeminiLive] Swap complete — new session ready');
  }

  async sendText(text) {
    if (!this.session) {
      console.warn('[GeminiLive] sendText called but no active session');
      return;
    }
    try {
      console.log(`[GeminiLive] Sending text: "${text}"`);
      await this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{ text }]
        }],
        turnComplete: true
      });
    } catch (e) {
      console.error('[GeminiLive] sendText error:', e.message);
    }
  }

  async sendAudio(base64AudioChunk) {
    if (!this.session) return;
    try {
      await this.session.sendRealtimeInput([{
        mimeType: 'audio/pcm;rate=16000',
        data: base64AudioChunk
      }]);
    } catch (e) {
      console.error('[GeminiLive] sendAudio error:', e.message);
    }
  }

  async sendVideo(base64VideoFrame) {
    if (!this.session) return;
    try {
      await this.session.sendRealtimeInput([{
        mimeType: 'image/jpeg',
        data: base64VideoFrame
      }]);
    } catch (e) {
      console.error('[GeminiLive] sendVideo error:', e.message);
    }
  }

  close() {
    this._intentionalClose = true;
    if (this.session) {
      try {
        if (typeof this.session.close === 'function') {
          this.session.close();
        }
      } catch (e) { /* ignore */ }
    }
    this.session = null;
    this.onOutputCallback = null;
    this.onTurnCompleteCallback = null;
    console.log('[GeminiLive] Session closed.');
  }
}

async function create(initialPrompt) {
  const liveSession = new GeminiLiveSession(initialPrompt);
  await liveSession.initialize(); // now waits for setupComplete before returning
  return liveSession;
}

module.exports = { create };