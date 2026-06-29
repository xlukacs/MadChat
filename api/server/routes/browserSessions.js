const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');
const {
  publicSession,
  createBrowserSession,
  getBrowserSession,
  updateBrowserSession,
  stopBrowserSession,
  attachBrowserSessionListener,
} = require('~/server/services/BrowserSessions');

const router = express.Router();

function assertInternalToken(req, res) {
  const expectedToken = process.env.BROWSER_INTERNAL_TOKEN;
  const providedToken = req.get('x-browser-internal-token');
  if (!expectedToken || providedToken !== expectedToken) {
    res.status(403).json({ error: 'Browser session internals are not enabled' });
    return false;
  }
  return true;
}

async function resolveSessionUserId({ userId, agentId }) {
  if (userId) {
    return userId;
  }
  if (!agentId) {
    return null;
  }
  const agent = await db.getAgent({ id: agentId });
  return agent?.author?.toString() ?? null;
}

router.post('/credentials', express.json(), async (req, res) => {
  if (!assertInternalToken(req, res)) {
    return;
  }

  const { agentId, origin, credentialId } = req.body ?? {};
  if (!agentId || (!origin && !credentialId)) {
    return res.status(400).json({ error: 'agentId and origin or credentialId are required' });
  }

  try {
    const normalizedOrigin = origin ? new URL(origin).origin : undefined;
    const credential = await db.getAgentCredential({
      agentId,
      origin: normalizedOrigin,
      credentialId,
    });
    if (!credential) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    return res.json(credential);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post('/internal', express.json({ limit: '1mb' }), async (req, res) => {
  if (!assertInternalToken(req, res)) {
    return;
  }

  const { userId, agentId, conversationId, startUrl } = req.body ?? {};
  if (!startUrl) {
    return res.status(400).json({ error: 'startUrl is required' });
  }

  try {
    const ownerId = await resolveSessionUserId({ userId, agentId });
    if (!ownerId) {
      return res.status(400).json({ error: 'userId or agentId is required' });
    }
    return res.json(
      createBrowserSession({
        userId: ownerId,
        agentId,
        conversationId,
        startUrl,
      }),
    );
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.get('/internal/:sessionId', (req, res) => {
  if (!assertInternalToken(req, res)) {
    return;
  }
  const session = getBrowserSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Browser session not found' });
  }
  return res.json(publicSession(session));
});

router.patch('/internal/:sessionId', express.json({ limit: '12mb' }), (req, res) => {
  if (!assertInternalToken(req, res)) {
    return;
  }
  const update = {};
  const { status, currentUrl, lastAction, screenshot, summary } = req.body ?? {};
  if (status) {
    update.status = status;
  }
  if (currentUrl) {
    update.currentUrl = currentUrl;
  }
  if (lastAction) {
    update.lastAction = lastAction;
  }
  if (summary) {
    update.summary = summary;
  }
  if (screenshot) {
    update.screenshot = screenshot;
  }
  const session = updateBrowserSession(req.params.sessionId, update);
  if (!session) {
    return res.status(404).json({ error: 'Browser session not found' });
  }
  return res.json(session);
});

router.use(requireJwtAuth);

function getOwnedSession(req, res) {
  const session = getBrowserSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Browser session not found' });
    return null;
  }
  if (session.userId !== req.user.id) {
    res.status(403).json({ error: 'You do not have access to this browser session' });
    return null;
  }
  return session;
}

router.get('/:sessionId', (req, res) => {
  const session = getOwnedSession(req, res);
  if (!session) {
    return;
  }
  res.json(publicSession(session));
});

router.get('/:sessionId/screenshot', (req, res) => {
  const session = getOwnedSession(req, res);
  if (!session) {
    return;
  }
  if (!session.screenshot) {
    res.status(404).json({ error: 'Browser session screenshot not available' });
    return;
  }
  const image = Buffer.from(session.screenshot, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(image);
});

router.get('/:sessionId/events', (req, res) => {
  const session = getOwnedSession(req, res);
  if (!session) {
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  attachBrowserSessionListener(session.sessionId, res);
  res.write(`event: browser-session\ndata: ${JSON.stringify(publicSession(session))}\n\n`);
});

router.post('/:sessionId/stop', (req, res) => {
  const session = getOwnedSession(req, res);
  if (!session) {
    return;
  }
  res.json(stopBrowserSession(session.sessionId));
});

module.exports = router;
