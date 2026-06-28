const crypto = require('node:crypto');

const DEFAULT_TTL_MS = Number(process.env.BROWSER_SESSION_TTL_MINUTES || 30) * 60 * 1000;
const sessions = new Map();
const listeners = new Map();

function now() {
  return new Date().toISOString();
}

function publicSession(session) {
  const { screenshot, ...rest } = session;
  return {
    ...rest,
    hasScreenshot: Boolean(screenshot),
  };
}

function publicEvent(session) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    currentUrl: session.currentUrl,
    lastAction: session.lastAction,
    hasScreenshot: Boolean(session.screenshot),
    updatedAt: session.updatedAt,
  };
}

function emit(sessionId, event) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  session.updatedAt = now();
  session.events.push(event);
  const payload = `event: browser-session\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners.get(sessionId) ?? []) {
    res.write(payload);
  }
}

function createBrowserSession({ userId, agentId, conversationId, startUrl }) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
  const session = {
    sessionId,
    userId,
    agentId,
    conversationId,
    status: 'starting',
    startUrl,
    currentUrl: startUrl,
    lastAction: 'Starting browser task',
    createdAt: now(),
    updatedAt: now(),
    expiresAt,
    events: [],
    screenshot: null,
  };
  sessions.set(sessionId, session);
  emit(sessionId, publicEvent(session));
  return publicSession(session);
}

function getBrowserSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  if (Date.parse(session.expiresAt) < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function updateBrowserSession(sessionId, update) {
  const session = getBrowserSession(sessionId);
  if (!session) {
    return null;
  }
  Object.assign(session, update, { updatedAt: now() });
  emit(sessionId, publicEvent(session));
  return publicSession(session);
}

function stopBrowserSession(sessionId) {
  const session = getBrowserSession(sessionId);
  if (!session) {
    return null;
  }
  session.status = 'stopped';
  session.lastAction = 'Stopped by user';
  emit(sessionId, publicEvent(session));
  return publicSession(session);
}

function attachBrowserSessionListener(sessionId, res) {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(res);
  listeners.set(sessionId, set);
  res.on('close', () => {
    set.delete(res);
    if (set.size === 0) {
      listeners.delete(sessionId);
    }
  });
}

module.exports = {
  createBrowserSession,
  getBrowserSession,
  updateBrowserSession,
  stopBrowserSession,
  attachBrowserSessionListener,
  publicSession,
};
