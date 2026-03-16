const { GoogleGenAI } = require('@google/genai');

let ai = null;
function getAI() {
  if (!ai) {
    ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION
    });
  }
  return ai;
}

const IMAGEN_STYLE_PREFIX =
  "Children's watercolor illustration, warm earthy tones, soft diffused edges, " +
  "golden hour lighting, age 6-12 storybook aesthetic, no text, no letters. Scene: ";

async function callImagen(sceneDescription) {
  const prompt = IMAGEN_STYLE_PREFIX + sceneDescription;
  console.log(`[Imagen] Generating image for: ${sceneDescription}`);

  const response = await getAI().models.generateImages({
    model: 'imagen-3.0-generate-001',
    prompt: prompt,
    config: { numberOfImages: 1 }
  });

  const base64 = response?.generatedImages?.[0]?.image?.imageBytes;
  return base64 || null;
}

async function generateImage(sceneDescription) {
  try {
    return await callImagen(sceneDescription);
  } catch (error) {
    const isQuota = error.status === 429 ||
                    error.status === 'RESOURCE_EXHAUSTED' ||
                    (error.message && error.message.includes('Quota'));
    if (isQuota) {
      console.log('[Imagen] Quota hit — retrying in 20s...');
      await new Promise(r => setTimeout(r, 20000));
      try {
        return await callImagen(sceneDescription);
      } catch {
        console.warn('[Imagen] Retry failed — skipping image');
        return null;
      }
    }
    console.error('[Imagen] Error:', error.message);
    return null;
  }
}

module.exports = { generateImage };
