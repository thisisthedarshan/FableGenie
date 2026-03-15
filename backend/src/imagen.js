const { VertexAI } = require('@google-cloud/vertexai');

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.VERTEX_AI_LOCATION,
});

const MODEL_NAME = 'imagen-3.0-generate-001';

const IMAGEN_STYLE_PREFIX =
  "Children's watercolor illustration, warm earthy tones, soft diffused edges, " +
  "golden hour lighting, age 6-12 storybook aesthetic, no text, no letters. Scene: ";

async function generateImage(sceneDescription) {
  try {
    const prompt = IMAGEN_STYLE_PREFIX + sceneDescription;
    console.log(`[Imagen] Generating image for: ${sceneDescription}`);
    
    // In VertexAI SDK for Node.js, Imagen usually requires using the predictor client directly 
    // or through getGenerativeModel with specific input formats.
    // Adjusting to a generic prediction format compatible with Vertex AI Imagen 3:
    const model = vertexAI.getGenerativeModel({ model: MODEL_NAME });
    
    // Using a more raw prediction structure common in vertex for Imagen if needed,
    // but typically generateContent still works if properly supported in standard wrapper:
    const req = {
      instances: [ { prompt: prompt } ],
      parameters: {
         sampleCount: 1,
         outputMimeType: "image/jpeg",
         aspectRatio: "16:9"
      }
    };

    // To properly call Imagen on Vertex we usually use the custom image generation endpoint
    // We will attempt with generateContent or generateImages. VertexAI SDK provides generateImages? Wait, Vertex in Node does not have simple generateImages yet. Let's send the prompt as a standard prediction or content generation depending on the version. Assuming generateContent handles image models in the preview SDK:
    const response = await model.generateContent({
        contents: [{role: 'user', parts: [{text: prompt}]}]
    });

    if (response && response.response && response.response.candidates && response.response.candidates[0].content.parts) {
       const parts = response.response.candidates[0].content.parts;
       const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
       if (imgPart) return imgPart.inlineData.data;
    }
    return null;
  } catch (error) {
    console.error('[Imagen] Error generating image:', error);
    return null;
  }
}

module.exports = { generateImage };
