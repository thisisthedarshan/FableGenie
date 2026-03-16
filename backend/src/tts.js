const { GoogleGenAI } = require('@google/genai');
const imagen = require('./imagen');
const imagePrompter = require('./imagePrompter');

let genAI = null;
function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION,
    });
  }
  return genAI;
}

const MODEL_NAME = 'gemini-2.5-flash-preview-tts';

// Minimum gap between Imagen calls to avoid quota exhaustion
const IMAGEN_MIN_GAP_MS = 12000;

class TTSPipeline {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.isSynthesizing = false;
    this.currentPlayIndex = 0;
    this.nextChunkIndex = 0;
    this.lookahead = 4; // synthesize 4 chunks ahead of playback (was 2)
    this.lastImageTime = 0; // rate-limit Imagen calls
  }

  async enqueue(text, phase) {
    this.queue.push({
      text,
      phase,
      chunkIndex: this.nextChunkIndex++,
      audioBase64: null,
      imageBase64: null,
      status: 'pending' // pending, synthesizing, ready, played
    });
    this.processQueue();
  }

  /**
   * Enqueue a branch marker. When the TTS queue reaches this item
   * (i.e. all preceding audio has been sent), it fires a
   * tts_branch_reached WebSocket message instead of synthesizing audio.
   */
  enqueueBranchMarker() {
    this.queue.push({
      text: null,
      phase: 'branch_marker',
      chunkIndex: this.nextChunkIndex++,
      audioBase64: null,
      imageBase64: null,
      status: 'pending'
    });
    this.processQueue();
  }

  advance(playedChunkIndex) {
    this.currentPlayIndex = playedChunkIndex + 1;
    for (let item of this.queue) {
      if (item.chunkIndex <= playedChunkIndex) {
        item.status = 'played';
        item.audioBase64 = null;
      }
    }
    this.processQueue();
  }

  async processQueue() {
    if (this.isSynthesizing) return;

    const toSynthesize = this.queue.find(item => item.status === 'pending');
    if (!toSynthesize || (toSynthesize.chunkIndex - this.currentPlayIndex >= this.lookahead)) {
      return;
    }

    // ── Branch marker: fire signal instead of synthesizing ──
    if (toSynthesize.phase === 'branch_marker') {
      toSynthesize.status = 'ready';
      console.log(`[TTS] Branch marker reached at chunk ${toSynthesize.chunkIndex}`);
      this.socket.send(JSON.stringify({ type: 'tts_branch_reached' }));
      toSynthesize.status = 'played';
      // Don't continue processing — wait for branch resolution
      return;
    }

    this.isSynthesizing = true;
    toSynthesize.status = 'synthesizing';

    try {
      console.log(`[TTS] Synthesizing chunk ${toSynthesize.chunkIndex}...`);

      const prefix = (toSynthesize.phase === 'qa_answer') ? '[speak conversationally]' : '[speak naturally and warmly]';
      const prompt = `${prefix} ${toSynthesize.text}`;

      const ai = getGenAI();

      // Parallelize TTS and Image Generation
      const ttsPromise = ai.models.generateContent({
        model: MODEL_NAME,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      });

      // Rate-limit Imagen: skip image if less than IMAGEN_MIN_GAP_MS since last
      let imagePromise = Promise.resolve(null);
      const now = Date.now();
      const canGenerateImage = (now - this.lastImageTime) >= IMAGEN_MIN_GAP_MS;

      if (toSynthesize.phase === 'narration' && canGenerateImage) {
        this.lastImageTime = now; // claim slot immediately to prevent races
        imagePromise = (async () => {
          const visualPrompt = await imagePrompter.getVisualPrompt(toSynthesize.text);
          return await imagen.generateImage(visualPrompt);
        })();
      } else if (toSynthesize.phase === 'narration') {
        console.log(`[TTS] Skipping image for chunk ${toSynthesize.chunkIndex} (rate limit: ${Math.round((IMAGEN_MIN_GAP_MS - (now - this.lastImageTime)) / 1000)}s remaining)`);
      }

      const [ttsResponse, imageBase64] = await Promise.all([ttsPromise, imagePromise]);

      let inlineData = null;
      if (ttsResponse && ttsResponse.candidates?.[0]?.content?.parts) {
        const audioPart = ttsResponse.candidates[0].content.parts.find(p => p.inlineData && p.inlineData.data);
        if (audioPart) inlineData = audioPart.inlineData;
      }

      if (inlineData) {
        toSynthesize.audioBase64 = inlineData.data;
        toSynthesize.imageBase64 = imageBase64;
        toSynthesize.status = 'ready';

        this.socket.send(JSON.stringify({
          type: 'tts_audio',
          audio: toSynthesize.audioBase64,
          image: toSynthesize.imageBase64, // could be null
          mimeType: inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000',
          chunkIndex: toSynthesize.chunkIndex
        }));
        console.log(`[TTS] Chunk ${toSynthesize.chunkIndex} ready (Sync Image: ${imageBase64 ? 'YES' : 'NO'})`);
      } else {
        console.warn(`[TTS] No audio data returned for chunk ${toSynthesize.chunkIndex}`);
        toSynthesize.status = 'played';
      }

    } catch (e) {
      console.error(`[TTS] Synthesis error for chunk ${toSynthesize.chunkIndex}:`, e);
      toSynthesize.status = 'played';
    } finally {
      this.isSynthesizing = false;
      this.processQueue();
    }
  }
}

module.exports = { TTSPipeline };