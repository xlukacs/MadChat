const { logger } = require('@librechat/data-schemas');
const { extractEnvVariable } = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');

const DEFAULT_REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';
const DEFAULT_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const DEFAULT_REALTIME_VOICE = 'alloy';

async function createRealtimeSession(req, res) {
  try {
    const { sdp, model: requestedModel, voice: requestedVoice, instructions } = req.body ?? {};
    if (typeof sdp !== 'string' || sdp.trim().length === 0) {
      return res.status(400).json({ error: 'Missing SDP offer in request body' });
    }

    const appConfig = await getAppConfig({ role: req.user?.role });
    const realtimeConfig = appConfig?.speech?.realtime ?? {};

    if (realtimeConfig?.enabled === false) {
      return res.status(403).json({ error: 'Realtime speech is disabled in config' });
    }

    const resolvedApiKey =
      extractEnvVariable(realtimeConfig?.apiKey) ||
      process.env.OPENAI_API_KEY ||
      extractEnvVariable(appConfig?.speech?.tts?.openai?.apiKey);

    if (!resolvedApiKey) {
      return res.status(500).json({ error: 'OpenAI API key is not configured for realtime' });
    }

    const realtimeUrl = realtimeConfig?.url || DEFAULT_REALTIME_URL;
    const model = requestedModel || realtimeConfig?.model || DEFAULT_REALTIME_MODEL;
    const voice = requestedVoice || realtimeConfig?.voice || DEFAULT_REALTIME_VOICE;
    const sessionInstructions =
      typeof instructions === 'string' && instructions.trim().length > 0
        ? instructions
        : realtimeConfig?.instructions;

    const session = {
      type: 'realtime',
      model,
      audio: {
        output: {
          voice,
        },
      },
    };

    if (sessionInstructions) {
      session.instructions = sessionInstructions;
    }

    const formData = new FormData();
    formData.set('sdp', sdp);
    formData.set('session', JSON.stringify(session));

    const response = await fetch(realtimeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolvedApiKey}`,
      },
      body: formData,
    });

    const responseBody = await response.text();
    if (!response.ok) {
      let userMessage = 'Failed to create realtime session';
      try {
        const parsed = JSON.parse(responseBody);
        const msg = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
        if (typeof msg === 'string' && msg.length > 0) {
          userMessage = msg;
        }
      } catch {
        if (responseBody && responseBody.length < 500) {
          userMessage = responseBody;
        }
      }
      logger.error('[Realtime] Failed to create session', {
        status: response.status,
        body: responseBody,
      });
      return res.status(response.status).json({
        error: userMessage,
        details: responseBody,
      });
    }

    return res.status(200).json({
      sdp: responseBody,
      callId: response.headers.get('Location') ?? null,
      model,
      voice,
    });
  } catch (error) {
    logger.error('[Realtime] Unexpected error creating session', error);
    return res.status(500).json({ error: 'Failed to create realtime session' });
  }
}

module.exports = {
  createRealtimeSession,
};
