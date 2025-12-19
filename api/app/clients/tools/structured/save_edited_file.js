const path = require('path');
const mime = require('mime');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { Tool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { FileContext } = require('librechat-data-provider');
const { sanitizeFilename } = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createFile, getFiles } = require('~/models');
 
const DEFAULT_MAX_CHARS = 2_000_000; // ~2MB of UTF-8 for typical text; enforced as chars for simplicity
const TEXT_EXT_ALLOWLIST = new Set(['.txt', '.md', '.json', '.js', '.ts', '.csv']);
 
/**
 * Structured tool that saves an edited text file as a new downloadable file.
 *
 * Expected runtime injection (when invoked in ToolService/Agents runtime):
 * - this.req: ServerRequest
 * - this.res: ServerResponse (optional; used only for streaming attachment events when available)
 */
module.exports = class SaveEditedFile extends Tool {
  name = 'save_edited_file';
 
  description =
    'Save an updated version of a previously uploaded text file. After calling this tool, you MUST return the updated content to the user inside EXACTLY ONE enclosed artifact block so it renders as a clickable Artifact card in the UI. Use type="text/markdown", title=the filename, identifier=the returned file_id, and the artifact body must be the FULL edited content. Only for text-like files (txt/md/json/js/ts/csv).';
 
  schema = z.object({
    source_file_id: z.string().min(1).describe('The file_id of the original uploaded file to base the edit on.'),
    content: z
      .string()
      .min(0)
      .describe('The full updated file content (plain text). Provide the complete new content.'),
    new_filename: z
      .string()
      .min(0)
      .optional()
      .describe('Optional new filename for the edited file. If omitted, derives from the source filename.'),
  });
 
  constructor(fields = {}) {
    super(fields);
    // These are injected at runtime by ToolService/loadTools options
    this.req = fields.req;
    this.res = fields.res;
    this.maxChars = fields.maxChars ?? DEFAULT_MAX_CHARS;
  }
 
  /**
   * @param {{ source_file_id: string; content: string; new_filename?: string }} input
   */
  async _call(input) {
    const req = this.req;
    if (!req?.user?.id) {
      throw new Error('save_edited_file: missing request context');
    }
 
    const { source_file_id, content, new_filename } = input || {};
    if (!source_file_id) {
      throw new Error('save_edited_file: source_file_id is required');
    }
 
    if (typeof content !== 'string') {
      throw new Error('save_edited_file: content must be a string');
    }
    if (content.length > this.maxChars) {
      throw new Error(`save_edited_file: content too large (max ${this.maxChars} chars)`);
    }
 
    // Lookup source file (owner-only for now)
    const files = await getFiles({ user: req.user.id, file_id: source_file_id });
    const sourceFile = Array.isArray(files) ? files[0] : null;
    if (!sourceFile) {
      throw new Error('save_edited_file: source file not found or not accessible');
    }
 
    const sourceExt = path.extname(sourceFile.filename || '') || '';
    const targetExt = sourceExt || path.extname(new_filename || '') || '';
    const effectiveExt = targetExt ? targetExt.toLowerCase() : '';
    if (!TEXT_EXT_ALLOWLIST.has(effectiveExt)) {
      throw new Error(
        `save_edited_file: unsupported file type "${effectiveExt || 'unknown'}" (allowed: ${Array.from(
          TEXT_EXT_ALLOWLIST,
        ).join(', ')})`,
      );
    }
 
    const rawTargetName = (new_filename && new_filename.trim()) || sourceFile.filename || `edited${effectiveExt}`;
    const ensuredExtName = path.extname(rawTargetName) ? rawTargetName : `${rawTargetName}${effectiveExt}`;
    const safeFilename = sanitizeFilename(ensuredExtName);
 
    const buffer = Buffer.from(content, 'utf8');
    const bytes = Buffer.byteLength(buffer);
 
    const appConfig = req.config;
    const source = appConfig.fileStrategy;
    const { saveBuffer } = getStrategyFunctions(source);
    if (!saveBuffer) {
      throw new Error(`save_edited_file: saveBuffer not implemented for source "${source}"`);
    }
 
    // Use the uploads basePath to match normal file uploads (not public images)
    const file_id = uuidv4();
    const storageFileName = `${file_id}__${safeFilename}`;
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
        file_id,
        bytes,
        filepath,
        filename: safeFilename,
        context: FileContext.message_attachment,
        source,
        type,
        embedded: false,
        usage: 0,
      },
      true,
    );
 
    // Return in the same general shape as other tools: include an artifact that upstream can turn into attachments.
    // Upstream code will augment with messageId/toolCallId/conversationId and stream as SSE `attachment` events.
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
      // Include explicit fields for the model to reference in the artifact directive.
      file_id: created.file_id,
      filename: created.filename,
      // Keep the tool output short and UI-friendly, but include the required artifact template.
      content: `Saved edited file as "${created.filename}".\n\nNow respond with:\n:::artifact{type="text/markdown" title="${created.filename}" identifier="${created.file_id}"}\n<PASTE FULL EDITED CONTENT HERE>\n:::`,
    };
  }
};


