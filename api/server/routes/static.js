const express = require('express');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const staticCache = require('../utils/staticCache');
const paths = require('~/config/paths');

const skipGzipScan = !isEnabled(process.env.ENABLE_IMAGE_OUTPUT_GZIP_SCAN);

const router = express.Router();
logger.info(`[StaticRoute] Serving images from: ${paths.imageOutput}`);
router.use(staticCache(paths.imageOutput, { skipGzipScan }));

module.exports = router;
