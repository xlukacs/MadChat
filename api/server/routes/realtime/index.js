const express = require('express');
const {
  requireJwtAuth,
  configMiddleware,
  checkBan,
  uaParser,
} = require('~/server/middleware');
const { createRealtimeSession } = require('~/server/controllers/realtime/session');

const router = express.Router();

router.use(requireJwtAuth);
router.use(configMiddleware);
router.use(checkBan);
router.use(uaParser);

router.post('/session', createRealtimeSession);

module.exports = router;
