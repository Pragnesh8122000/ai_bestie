import app from './app';
import { config } from './config';
import { connectDatabase } from './config/database';
import { initTts, ttsStatus } from './services/ttsService';

const start = async () => {
  try {
    if (!config.llm.geminiApiKey && !config.llm.openrouterApiKey) {
      console.warn('\n⚠️  No LLM key set. Chat will not work.');
      console.warn('   Primary: GEMINI_API_KEY (free, https://aistudio.google.com/apikey)');
      console.warn('   Fallback: OPENROUTER_API_KEY (free, https://openrouter.ai/keys)');
      console.warn('   Paste either/both into /.env or /server/.env\n');
    } else {
      if (config.llm.geminiApiKey) {
        console.log(`Gemini model (primary): ${config.llm.geminiModel} (reasoning off)`);
      } else {
        console.log('Gemini: no key — using OpenRouter as primary');
      }
      if (config.llm.openrouterApiKey) {
        console.log(`OpenRouter model (fallback): ${config.llm.openrouterModel}`);
      }
    }

    await connectDatabase();
    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
      console.log(`Health check: http://localhost:${config.port}/api/health`);
    });

    // Load the neural TTS model in the background so boot isn't blocked even if
    // the model is large (or absent). When it resolves, log the outcome; voice
    // replies fall back to browser speechSynthesis until/unless it's loaded.
    if (config.tts.enabled) {
      initTts()
        .then(() => {
          const s = ttsStatus();
          if (s.available) {
            console.log(`TTS: Kokoro loaded (${s.sampleRate} Hz) — neural voice replies ready`);
          } else {
            console.warn(
              `TTS: unavailable — ${s.error}. Voice replies will use browser speechSynthesis.`,
            );
            console.warn('   Download the model: npm run download-tts-model -w server');
          }
        })
        .catch(() => {
          /* initTts swallows errors internally; nothing to do here */
        });
    } else {
      console.log('TTS: disabled (TTS_ENABLED=false) — using browser speechSynthesis');
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

start();