/**
 * lyria.js
 *
 * Uses lyria-002 via the Vertex AI Prediction Service (REST/gRPC).
 * This is the model accessible from the Model Garden, NOT lyria-realtime-exp.
 *
 * lyria-002 is a batch generation model:
 *   - Send a text prompt describing the music
 *   - Receive a base64-encoded audio clip (~30s WAV)
 *   - Play it as a looping ambient backdrop
 *
 * When lyria-002 is unavailable or fails, falls back to sending a
 * { type: 'mood_change', mood } WebSocket message so the frontend
 * can play Web Audio API synthesis instead.
 *
 * Required package: @google-cloud/aiplatform
 * Install: npm install @google-cloud/aiplatform
 */

const { PredictionServiceClient } = require('@google-cloud/aiplatform').v1;
const { helpers } = require('@google-cloud/aiplatform');

const PROJECT = () => process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = () => process.env.VERTEX_AI_LOCATION || 'us-central1';
const MODEL = 'lyria-002';

// Cache the client — creating it is expensive
let predictionClient = null;
function getClient() {
  if (!predictionClient) {
    predictionClient = new PredictionServiceClient({
      apiEndpoint: `${LOCATION()}-aiplatform.googleapis.com`
    });
  }
  return predictionClient;
}

// Mood → music prompt mapping
const MOOD_PROMPTS = {
  peaceful: 'Calm, gentle ambient background music. Soft acoustic instruments. Nature sounds. Soothing and warm. Children\'s storybook atmosphere. Loopable.',
  tense: 'Suspenseful underscore. Low strings, subtle tension. Quiet unease building slowly. Storybook atmosphere. Loopable.',
  joyful: 'Uplifting, playful background music. Light and bouncy. Cheerful woodwinds. Children\'s storybook. Happy and warm. Loopable.',
  suspenseful: 'Building tension, quiet dread. Cinematic underscore. Slow rising strings. Storybook atmosphere. Loopable.',
  triumphant: 'Triumphant, uplifting resolution. Warm brass and strings. Victory theme. Children\'s storybook. Loopable.',
};

class LyriaStream {
  constructor(socket) {
    this.socket = socket;
    this.isOpen = false;
    this.currentMood = null;
    this._lyriaAvailable = null; // null = untested, true/false = known
  }

  async open() {
    // Don't actually open a persistent stream — lyria-002 is request/response.
    // Mark as "open" so setMood calls proceed.
    this.isOpen = true;
    console.log('[Lyria] Stream opened (lyria-002 request/response mode)');
  }

  async setMood(mood) {
    if (!this.isOpen) return;
    if (mood === this.currentMood) return;
    this.currentMood = mood;

    console.log(`[Lyria] Generating music for mood: ${mood}`);

    // Always send mood_change first so Web Audio fallback fires immediately
    // while we wait for the lyria-002 response (which takes a few seconds)
    this.socket.send(JSON.stringify({ type: 'mood_change', mood }));

    // Skip lyria-002 call if we already know it's unavailable
    if (this._lyriaAvailable === false) return;

    try {
      const audioBase64 = await this._generateMusic(mood);
      if (audioBase64) {
        // Send real Lyria audio — frontend will prefer this over Web Audio synthesis
        this.socket.send(JSON.stringify({ type: 'lyria_pcm', data: audioBase64 }));
        console.log(`[Lyria] Music ready for mood: ${mood}`);
        this._lyriaAvailable = true;
      }
    } catch (e) {
      console.warn(`[Lyria] lyria-002 unavailable (${e.message}) — Web Audio fallback active`);
      this._lyriaAvailable = false;
      // mood_change was already sent above — frontend fallback already running
    }
  }

  async _generateMusic(mood) {
    const prompt = MOOD_PROMPTS[mood] || MOOD_PROMPTS.peaceful;
    const endpoint = `projects/${PROJECT()}/locations/${LOCATION()}/publishers/google/models/${MODEL}`;

    const instance = helpers.toValue({ prompt });

    const [response] = await getClient().predict({
      endpoint,
      instances: [instance],
      parameters: helpers.toValue({})
    });

    if (!response.predictions || response.predictions.length === 0) {
      throw new Error('No predictions returned from lyria-002');
    }

    // Extract audio bytes from prediction
    // lyria-002 returns { bytesBase64Encoded: "..." } or { audio: "..." }
    const pred = helpers.fromValue(response.predictions[0]);
    const audioData = pred?.bytesBase64Encoded || pred?.audio || pred?.audioContent;

    if (!audioData) {
      throw new Error(`Unexpected lyria-002 response shape: ${JSON.stringify(pred)}`);
    }

    return audioData; // already base64
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.currentMood = null;
    console.log('[Lyria] Stream closed');
    // Returns undefined intentionally — callers guard with typeof .catch check
  }
}

module.exports = { LyriaStream };