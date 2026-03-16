require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeWav(filename, pcmChunks, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const pcmData = Buffer.concat(pcmChunks);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);
  let o = 0;
  header.write('RIFF', o); o += 4;
  header.writeUInt32LE(36 + dataSize, o); o += 4;
  header.write('WAVE', o); o += 4;
  header.write('fmt ', o); o += 4;
  header.writeUInt32LE(16, o); o += 4;
  header.writeUInt16LE(1, o); o += 2;  // PCM
  header.writeUInt16LE(channels, o); o += 2;
  header.writeUInt32LE(sampleRate, o); o += 4;
  header.writeUInt32LE(byteRate, o); o += 4;
  header.writeUInt16LE(blockAlign, o); o += 2;
  header.writeUInt16LE(bitDepth, o); o += 2;
  header.write('data', o); o += 4;
  header.writeUInt32LE(dataSize, o);
  fs.writeFileSync(filename, Buffer.concat([header, pcmData]));
}

// Cross-platform audio playback — no extra packages needed.
// Windows  → PowerShell Media.SoundPlayer (always available)
// macOS    → afplay (built-in)
// Linux    → aplay (built-in on most distros)
function playFile(filepath) {
  const abs = path.resolve(filepath);
  let cmd;
  if (process.platform === 'win32') {
    // PlaySync() blocks until playback finishes — perfect for a test script
    cmd = `powershell -NoProfile -Command "` +
      `$p = New-Object Media.SoundPlayer '${abs.replace(/'/g, "\\'")}'; ` +
      `$p.PlaySync()"`;
  } else if (process.platform === 'darwin') {
    cmd = `afplay "${abs}"`;
  } else {
    cmd = `aplay "${abs}"`;
  }

  console.log('\n▶  Playing audio...');
  exec(cmd, (err) => {
    if (err) {
      // Fallback: just open the file in the default player
      console.warn('   Direct playback failed, opening in default player instead...');
      const open = process.platform === 'win32' ? `start "" "${abs}"`
        : process.platform === 'darwin' ? `open "${abs}"`
          : `xdg-open "${abs}"`;
      exec(open);
    } else {
      console.log('✓  Playback complete\n');
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const outputFile = path.join(__dirname, 'test-output.wav');
  const audioChunks = [];
  let detectedRate = 24000;  // Gemini Live default sample rate

  console.log('\nFableGenie — Gemini Live audio test');
  console.log('─────────────────────────────────────');
  console.log(`Project  : ${process.env.GOOGLE_CLOUD_PROJECT}`);
  console.log(`Location : ${process.env.VERTEX_AI_LOCATION}`);
  console.log(`Model    : gemini-live-2.5-flash-native-audio\n`);

  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION
    });

    await new Promise(async (resolve, reject) => {
      const session = await ai.live.connect({
        model: 'gemini-live-2.5-flash-native-audio',
        config: {
          // Do NOT add responseModalities: ['TEXT'] — this model is audio-native.
          // TEXT mode causes an immediate socket close.
          systemInstruction: {
            parts: [{ text: 'You are FableGenie, a warm and magical storyteller for children. Keep responses to 2-3 sentences.' }]
          }
        },
        callbacks: {

          onmessage: (msg) => {

            // ── Setup confirmed — safe to send now ───────────────────────────
            if (msg.setupComplete) {
              console.log(`✓ Connected  session: ${msg.setupComplete.sessionId}`);
              console.log('  Sending prompt...\n');
              try {
                session.sendClientContent({
                  turns: [{
                    role: 'user',
                    parts: [{ text: 'Say hello and tell me what kind of stories you tell. Two sentences only.' }]
                  }],
                  turnComplete: true
                });
              } catch (e) {
                reject(e);
              }
              return;
            }

            // ── Audio chunks arriving ────────────────────────────────────────
            if (msg.serverContent?.modelTurn?.parts) {
              for (const part of msg.serverContent.modelTurn.parts) {
                if (part.inlineData) {
                  // Detect actual sample rate from first chunk's mimeType
                  // e.g. "audio/pcm;rate=24000" or "audio/pcm;rate=16000"
                  if (audioChunks.length === 0) {
                    const rateMatch = (part.inlineData.mimeType || '').match(/rate=(\d+)/);
                    if (rateMatch) detectedRate = parseInt(rateMatch[1]);
                    console.log(`  Audio format : ${part.inlineData.mimeType}`);
                    console.log(`  Sample rate  : ${detectedRate} Hz`);
                    process.stdout.write('  Receiving   : ');
                  }
                  audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
                  process.stdout.write('▓');
                }
                if (part.text) {
                  // Native audio model won't emit text but log it if it does
                  console.log(`\n  Text chunk   : "${part.text}"`);
                }
              }
            }

            // ── Turn complete — write WAV and play ───────────────────────────
            if (msg.serverContent?.turnComplete) {
              const totalBytes = audioChunks.reduce((n, c) => n + c.length, 0);
              const durationSec = (totalBytes / 2 / detectedRate).toFixed(2); // 16-bit = 2 bytes/sample

              console.log(`\n\n  Chunks  : ${audioChunks.length}`);
              console.log(`  Bytes   : ${totalBytes.toLocaleString()}`);
              console.log(`  Duration: ~${durationSec}s`);
              if (msg.usageMetadata) {
                console.log(`  Tokens  : ${msg.usageMetadata.totalTokenCount}`);
              }

              writeWav(outputFile, audioChunks, detectedRate, 1, 16);
              console.log(`✓ WAV saved : ${outputFile}`);

              session.close?.();
              resolve();
            }
          },

          onerror: (err) => {
            console.error('\n✗ WebSocket error:', err);
            reject(err);
          },

          onclose: () => {
            // onclose fires after turnComplete — resolve either way
            resolve();
          }
        }
      });
    });

    if (audioChunks.length === 0) {
      console.error('\n✗ No audio received. Check:');
      console.error('  1. gcloud auth application-default login');
      console.error('  2. gcloud auth application-default set-quota-project fable-genie');
      console.error('  3. GOOGLE_CLOUD_PROJECT in .env matches your GCP project');
      process.exit(1);
    }

    // Play the file immediately
    playFile(outputFile);

  } catch (e) {
    console.error('\n✗ Fatal:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
})();