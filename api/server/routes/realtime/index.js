const express = require('express');
const {
  requireJwtAuth,
  configMiddleware,
  checkBan,
  uaParser,
} = require('~/server/middleware');
const { createRealtimeSession } = require('~/server/controllers/realtime/session');
const {
  getRealtimeTools,
  executeRealtimeToolHandler,
} = require('~/server/controllers/realtime/tools');

const router = express.Router();

router.use(requireJwtAuth);
router.use(configMiddleware);
router.use(checkBan);
router.use(uaParser);

router.post('/session', createRealtimeSession);
router.get('/tools', getRealtimeTools);
router.post('/tools/execute', executeRealtimeToolHandler);

module.exports = router;
