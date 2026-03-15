const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'imagen-3.0-generate-001';

const IMAGEN_STYLE_PREFIX =
  "Children's watercolor illustration, warm earthy tones, soft diffused edges, " +
  "golden hour lighting, age 6-12 storybook aesthetic, no text, no letters. Scene: ";

async function generateImage(sceneDescription) {
  try {
    const prompt = IMAGEN_STYLE_PREFIX + sceneDescription;
    console.log(`[Imagen] Generating image for: ${sceneDescription}`);
    
    // According to @google/genai SDK for imagen
    const response = await ai.models.generateImages({
        model: MODEL_NAME,
        prompt: prompt,
        config: {
            numberOfImages: 1,
            outputMimeType: "image/jpeg",
            aspectRatio: "16:9"
        }
    });

    if (response && response.generatedImages && response.generatedImages.length > 0) {
       return response.generatedImages[0].image.imageBytes; // base64 string
    }
    return null;
  } catch (error) {
    console.error('[Imagen] Error generating image:', error);
    return null;
  }
}

module.exports = { generateImage };
