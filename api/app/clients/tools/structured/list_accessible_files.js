const path = require('path');
const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { PermissionBits, ResourceType } = require('librechat-data-provider');
const { getAgents } = require('~/models/Agent');
const { getFiles } = require('~/models');
const {
  findAccessibleResources,
  findPubliclyAccessibleResources,
} = require('~/server/services/PermissionService');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const escapePipes = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

const formatBytes = (bytes) => {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Structured tool that lists all files the user can access:
 * - Files they own
 * - Files attached to agents they can VIEW (ownership, ACL shares, public)
 *
 * Returns a markdown table intended to be rendered as an Artifact card.
 *
 * Runtime injection:
 * - this.req: ServerRequest
 */
module.exports = class ListAccessibleFiles extends Tool {
  name = 'list_accessible_files';

  description =
    'List all files the current user has access to (owned + shared via agent permissions). After calling, you MUST respond with EXACTLY ONE enclosed artifact block containing a markdown table of files, including file_id so the user can reference it for downloads.';

  schema = z.object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    include_agent_files: z
      .boolean()
      .optional()
      .describe('Include files accessible via agents the user can VIEW. Default true.'),
  });

  constructor(fields = {}) {
    super(fields);
    this.req = fields.req;
  }

  async _call(input) {
    const req = this.req;
    if (!req?.user?.id) {
      throw new Error('list_accessible_files: missing request context');
    }

    const includeAgentFiles = input?.include_agent_files !== false;
    const limit = Math.min(Math.max(1, input?.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    const userId = req.user.id;

    /** Pull owned files */
    const ownedFiles = (await getFiles({ user: userId }, null, { text: 0 })) ?? [];
    const fileMap = new Map();
    const viaMap = new Map(); // file_id -> Set<string>

    for (const f of ownedFiles) {
      if (!f?.file_id) continue;
      fileMap.set(f.file_id, f);
      viaMap.set(f.file_id, new Set(['owned']));
    }

    if (includeAgentFiles) {
      // Agents the user can access: ownership + ACL shares + public agents
      const ownedAgentIds = await getAgents({ author: userId }).then((agents) =>
        (agents ?? []).map((a) => a._id).filter(Boolean),
      );
      const accessibleAgentIds = await findAccessibleResources({
        userId,
        role: req.user.role,
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      });
      const publicAgentIds = await findPubliclyAccessibleResources({
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.VIEW,
      });

      const agentIds = Array.from(
        new Set(
          []
            .concat(ownedAgentIds ?? [])
            .concat(accessibleAgentIds ?? [])
            .concat(publicAgentIds ?? [])
            .map((id) => id?.toString?.() ?? String(id)),
        ),
      )
        .filter(Boolean)
        .slice(0, 2000); // safety cap

      if (agentIds.length > 0) {
        const agents = await getAgents({ _id: { $in: agentIds } });
        const allFileIds = new Set();
        const agentNameByFileId = new Map(); // file_id -> Set(agentNameOrId)

        for (const agent of agents ?? []) {
          const agentLabel = agent?.name || agent?.id || agent?._id?.toString?.() || 'agent';
          const toolResources = agent?.tool_resources ?? {};
          for (const resource of Object.values(toolResources)) {
            const ids = resource?.file_ids;
            if (!Array.isArray(ids)) continue;
            for (const fid of ids) {
              if (!fid) continue;
              allFileIds.add(fid);
              if (!agentNameByFileId.has(fid)) agentNameByFileId.set(fid, new Set());
              agentNameByFileId.get(fid).add(agentLabel);
            }
          }
        }

        if (allFileIds.size > 0) {
          const sharedFiles = (await getFiles({ file_id: { $in: Array.from(allFileIds) } }, null, { text: 0 })) ?? [];
          for (const f of sharedFiles) {
            if (!f?.file_id) continue;
            if (!fileMap.has(f.file_id)) fileMap.set(f.file_id, f);
            if (!viaMap.has(f.file_id)) viaMap.set(f.file_id, new Set());
            const via = viaMap.get(f.file_id);
            const agentLabels = agentNameByFileId.get(f.file_id);
            if (agentLabels && agentLabels.size > 0) {
              for (const label of agentLabels) via.add(`agent:${label}`);
            } else {
              via.add('agent');
            }
          }
        }
      }
    }

    const files = Array.from(fileMap.values())
      .map((f) => {
        const via = Array.from(viaMap.get(f.file_id) ?? new Set());
        return {
          file_id: f.file_id,
          filename: f.filename,
          bytes: f.bytes,
          type: f.type,
          source: f.source,
          context: f.context,
          updatedAt: f.updatedAt,
          createdAt: f.createdAt,
          access_via: via,
        };
      })
      .sort((a, b) => {
        const at = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
        const bt = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
        return bt - at;
      })
      .slice(0, limit);

    const header = '| Filename | file_id | Size | Type | Source | Context | Access |\n|---|---|---:|---|---|---|---|';
    const rows = files.map((f) => {
      const access = (f.access_via ?? []).slice(0, 3).join(', ') + ((f.access_via ?? []).length > 3 ? ', …' : '');
      return `| ${escapePipes(f.filename)} | \`${escapePipes(f.file_id)}\` | ${escapePipes(
        formatBytes(f.bytes),
      )} | ${escapePipes(f.type)} | ${escapePipes(f.source)} | ${escapePipes(f.context)} | ${escapePipes(access)} |`;
    });

    const table = [header, ...rows].join('\n');
    const artifactTitle = `Accessible files (${files.length})`;
    const artifact = `:::artifact{type="text/markdown" title="${artifactTitle}" identifier="accessible_files"}\n${table}\n:::`;

    return {
      files,
      table,
      content:
        `Found ${files.length} accessible file(s).\n\n` +
        `Now respond with EXACTLY ONE enclosed artifact block:\n` +
        artifact,
    };
  }
};



