const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function run() {
  const configPath = path.join(process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config'), 'interview-coder-v1', 'config.json');
  let apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey && fs.existsSync(configPath)) {
    try {
      const appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      apiKey = appConfig.apiKey;
    } catch (e) {
      console.warn("Could not read API key from app configuration:", e.message);
    }
  }

  if (!apiKey) {
    console.error("No API key found in .env or app configuration.");
    return;
  }
  
  const genAI = new GoogleGenerativeAI(apiKey);
  
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    
    // Test with outputDimensionality
    const res = await model.embedContent({
      content: { role: "user", parts: [{ text: "Hello world" }] },
      outputDimensionality: 768
    });
    
    console.log(`✅ Model 'gemini-embedding-001' with outputDimensionality 768 works! Embedding length: ${res.embedding.values.length}`);
  } catch (e) {
    console.log(`❌ Model 'gemini-embedding-001' with outputDimensionality 768 failed: ${e.message}`);
  }
}
run();
