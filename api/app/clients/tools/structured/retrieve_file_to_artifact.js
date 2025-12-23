const path = require('path');
const mime = require('mime');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { Tool } = require('@langchain/core/tools');
const { Readable } = require('stream');
const { logger } = require('@librechat/data-schemas');
const {
  FileContext,
  FileSources,
  EModelEndpoint,
  checkOpenAIStorage,
} = require('librechat-data-provider');
const { sanitizeFilename } = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { createFile, getFiles } = require('~/models');

const DEFAULT_MAX_CHARS = 2_000_000;
const TEXT_EXT_ALLOWLIST = new Set(['.txt', '.md', '.json', '.js', '.ts', '.csv']);

/**
 * Read a Node.js readable stream into a UTF-8 string with a max byte limit.
 * @param {import('stream').Readable} stream
 * @param {number} maxBytes
 */
async function streamToUtf8(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      chunks.push(buf.subarray(0, Math.max(0, buf.length - (total - maxBytes))));
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
    }
    chunks.push(buf);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

/**
 * Structured tool that retrieves an existing user-accessible file by file_id and returns
 * a markdown artifact template + creates a stored downloadable copy.
 *
 * Runtime injection:
 * - this.req: ServerRequest
 * - this.res: ServerResponse (optional)
 */
module.exports = class RetrieveFileToArtifact extends Tool {
  name = 'retrieve_file_to_artifact';

  description =
    'Retrieve a user-accessible text file by file_id. This tool will read the file content (text-only), create a new stored downloadable copy, and return a ready-to-paste markdown artifact block. After calling, you MUST respond with EXACTLY ONE enclosed artifact block using type="text/markdown", title, identifier, and the full content.';

  schema = z.object({
    source_file_id: z.string().min(1).describe('The file_id to retrieve.'),
    as_filename: z
      .string()
      .min(0)
      .optional()
      .describe('Optional filename to use for the output. Defaults to the source filename.'),
    artifact_title: z
      .string()
      .min(0)
      .optional()
      .describe('Optional artifact title. Defaults to the output filename.'),
    max_chars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max characters to return in retrieved_content (default ${DEFAULT_MAX_CHARS}).`),
  });

  constructor(fields = {}) {
    super(fields);
    this.req = fields.req;
    this.res = fields.res;
    this.maxChars = fields.maxChars ?? DEFAULT_MAX_CHARS;
  }

  async _call(input) {
    const req = this.req;
    if (!req?.user?.id) {
      throw new Error('retrieve_file_to_artifact: missing request context');
    }

    const { source_file_id, as_filename, artifact_title, max_chars } = input || {};
    if (!source_file_id) {
      throw new Error('retrieve_file_to_artifact: source_file_id is required');
    }

    const maxChars = typeof max_chars === 'number' ? Math.min(max_chars, this.maxChars) : this.maxChars;
    const maxBytes = Math.max(1, maxChars * 4); // worst-case UTF-8

    // Lookup source file (owner-only for now, consistent with save_edited_file)
    const files = await getFiles({ user: req.user.id, file_id: source_file_id });
    const sourceFile = Array.isArray(files) ? files[0] : null;
    if (!sourceFile) {
      throw new Error('retrieve_file_to_artifact: source file not found or not accessible');
    }

    const sourceExt = path.extname(sourceFile.filename || '').toLowerCase();
    if (!TEXT_EXT_ALLOWLIST.has(sourceExt)) {
      throw new Error(
        `retrieve_file_to_artifact: unsupported file type "${sourceExt || 'unknown'}" (allowed: ${Array.from(
          TEXT_EXT_ALLOWLIST,
        ).join(', ')})`,
      );
    }

    // Download content using the same strategy mechanisms as /api/files/download
    let nodeStream;
    if (checkOpenAIStorage(sourceFile.source)) {
      if (!sourceFile.model) {
        throw new Error('retrieve_file_to_artifact: source file has no associated model');
      }
      const endpointMap = {
        [FileSources.openai]: EModelEndpoint.assistants,
        [FileSources.azure]: EModelEndpoint.azureAssistants,
      };
      req.body = { ...(req.body ?? {}), model: sourceFile.model };
      const { openai } = await getOpenAIClient({
        req,
        res: this.res,
        overrideEndpoint: endpointMap[sourceFile.source],
      });
      const { getDownloadStream } = getStrategyFunctions(sourceFile.source);
      const passThrough = await getDownloadStream(sourceFile.file_id, openai);
      nodeStream =
        passThrough.body && typeof passThrough.body.getReader === 'function'
          ? Readable.fromWeb(passThrough.body)
          : passThrough.body;
    } else {
      const { getDownloadStream } = getStrategyFunctions(sourceFile.source);
      if (!getDownloadStream) {
        throw new Error(`retrieve_file_to_artifact: no download stream for source "${sourceFile.source}"`);
      }
      nodeStream = await getDownloadStream(req, sourceFile.filepath);
    }

    if (!nodeStream) {
      throw new Error('retrieve_file_to_artifact: failed to obtain download stream');
    }

    const { text: retrievedContent, truncated } = await streamToUtf8(nodeStream, maxBytes);

    const rawName = (as_filename && as_filename.trim()) || sourceFile.filename || `file${sourceExt}`;
    const ensuredExtName = path.extname(rawName) ? rawName : `${rawName}${sourceExt}`;
    const safeFilename = sanitizeFilename(ensuredExtName);
    const title = (artifact_title && artifact_title.trim()) || safeFilename;

    // Create a stored downloadable copy in the configured fileStrategy under uploads/
    const buffer = Buffer.from(retrievedContent, 'utf8');
    const bytes = Buffer.byteLength(buffer);
    const appConfig = req.config;
    const storageSource = appConfig.fileStrategy;
    const { saveBuffer } = getStrategyFunctions(storageSource);
    if (!saveBuffer) {
      throw new Error(`retrieve_file_to_artifact: saveBuffer not implemented for source "${storageSource}"`);
    }

    const out_file_id = uuidv4();
    const storageFileName = `${out_file_id}__${safeFilename}`;
    const filepath = await saveBuffer({
      userId: req.user.id,
      buffer,
      fileName: storageFileName,
      basePath: 'uploads',
    });

    const type = mime.getType(safeFilename) || 'text/plain';
    const created = await createFile(
      {
        user: req.user.id,
        file_id: out_file_id,
        bytes,
        filepath,
        filename: safeFilename,
        context: FileContext.message_attachment,
        source: storageSource,
        type,
        embedded: false,
        usage: 0,
      },
      true,
    );

    const artifactTemplate = `:::artifact{type="text/markdown" title="${title}" identifier="${created.file_id}"}\n${retrievedContent}\n:::`;

    return {
      artifact: {
        saved_files: [
          {
            file_id: created.file_id,
            filename: created.filename,
            filepath: created.filepath,
            bytes: created.bytes,
            type: created.type,
            source: created.source,
          },
        ],
      },
      file_id: created.file_id,
      filename: created.filename,
      retrieved_content: retrievedContent,
      truncated,
      content:
        `Retrieved "${sourceFile.filename}". Created downloadable copy "${created.filename}".\n\n` +
        `Now respond with EXACTLY ONE enclosed artifact block:\n` +
        artifactTemplate,
    };
  }
};



