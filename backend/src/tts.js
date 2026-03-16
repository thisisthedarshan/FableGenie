const { GoogleGenAI } = require('@google/genai');

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

class TTSPipeline {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.isSynthesizing = false;
    this.currentPlayIndex = 0;
    this.nextChunkIndex = 0;
    this.lookahead = 4; // synthesize 4 chunks ahead of playback (was 2)
  }

  async enqueue(text, phase) {
    this.queue.push({
      text,
      phase,
      chunkIndex: this.nextChunkIndex++,
      audioBase64: null,
      status: 'pending' // pending, synthesizing, ready, played
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

    this.isSynthesizing = true;
    toSynthesize.status = 'synthesizing';

    try {
      console.log(`[TTS] Synthesizing chunk ${toSynthesize.chunkIndex}...`);

      const stylePrefixMap = {
        setup: '[speak naturally and warmly]',
        greeting: '[speak naturally and warmly]',
        narration: '[speak naturally and warmly]',
        qa_answer: '[speak conversationally]',
        closing: '[speak gently and warmly]',
      };

      const prefix = stylePrefixMap[toSynthesize.phase] || '[speak naturally]';
      const prompt = `${prefix} ${toSynthesize.text}`;

      const ai = getGenAI();

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore'
              }
            }
          }
        }
      });

      let inlineData = null;
      if (response && response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
        const parts = response.candidates[0].content.parts;
        const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
        if (audioPart) {
          inlineData = audioPart.inlineData;
        }
      }

      if (inlineData) {
        toSynthesize.audioBase64 = inlineData.data;
        toSynthesize.status = 'ready';

        this.socket.send(JSON.stringify({
          type: 'tts_audio',
          data: toSynthesize.audioBase64,
          mimeType: inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000',
          chunkIndex: toSynthesize.chunkIndex
        }));
        console.log(`[TTS] Chunk ${toSynthesize.chunkIndex} ready — mimeType: ${inlineData.mimeType}`);
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