import { useMemo, useState, useEffect, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { Button, Skeleton } from '@librechat/client';
import { Loader2, TriangleAlert } from 'lucide-react';
import {
  Constants,
  dataService,
  imageExtRegex,
  actionDelimiter,
  actionDomainSeparator,
} from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { useLocalize, useProgress, useExpandCollapse } from '~/hooks';
import { ToolIcon, getToolIconType, isError } from './ToolOutput';
import { useMCPIconMap } from '~/hooks/MCP';
import { AttachmentGroup } from './Parts';
import ToolCallInfo from './ToolCallInfo';
import ProgressText from './ProgressText';
import { logger } from '~/utils';
import store from '~/store';

export default function ToolCall({
  initialProgress = 0.1,
  isLast = false,
  isSubmitting,
  name,
  args: _args = '',
  output,
  attachments,
  auth,
  hideAttachments = false,
}: {
  initialProgress: number;
  isLast?: boolean;
  isSubmitting: boolean;
  name: string;
  args: string | Record<string, unknown>;
  output?: string | null;
  attachments?: TAttachment[];
  auth?: string;
  hideAttachments?: boolean;
}) {
  const localize = useLocalize();
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const hasOutput = (output?.length ?? 0) > 0;
  const [showInfo, setShowInfo] = useState(() => autoExpand && hasOutput);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(showInfo);

  useEffect(() => {
    if (autoExpand && hasOutput) {
      setShowInfo(true);
    }
  }, [autoExpand, hasOutput]);

  const parsedAuthUrl = useMemo(() => {
    if (!auth) {
      return null;
    }
    try {
      return new URL(auth);
    } catch {
      return null;
    }
  }, [auth]);

  const { function_name, domain, isMCPToolCall, mcpServerName } = useMemo(() => {
    if (typeof name !== 'string') {
      return { function_name: '', domain: null, isMCPToolCall: false, mcpServerName: '' };
    }
    if (name.includes(Constants.mcp_delimiter)) {
      const parts = name.split(Constants.mcp_delimiter);
      const func = parts[0];
      const server = parts.slice(1).join(Constants.mcp_delimiter);
      const displayName = func === 'oauth' ? server : func;
      return {
        function_name: displayName || '',
        domain: server && (server.replaceAll(actionDomainSeparator, '.') || null),
        isMCPToolCall: true,
        mcpServerName: server || '',
      };
    }

    if (parsedAuthUrl) {
      const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri') || '';
      const mcpMatch = redirectUri.match(/\/api\/mcp\/([^/]+)\/oauth\/callback/);
      if (mcpMatch?.[1]) {
        return {
          function_name: mcpMatch[1],
          domain: null,
          isMCPToolCall: true,
          mcpServerName: mcpMatch[1],
        };
      }
    }

    const [func, _domain] = name.includes(actionDelimiter)
      ? name.split(actionDelimiter)
      : [name, ''];
    return {
      function_name: func || '',
      domain: _domain && (_domain.replaceAll(actionDomainSeparator, '.') || null),
      isMCPToolCall: false,
      mcpServerName: '',
    };
  }, [name, parsedAuthUrl]);

  const toolIconType = useMemo(() => getToolIconType(name), [name]);
  const mcpIconMap = useMCPIconMap();
  const mcpIconUrl = isMCPToolCall ? mcpIconMap.get(mcpServerName) : undefined;

  const actionId = useMemo(() => {
    if (isMCPToolCall || !parsedAuthUrl) {
      return '';
    }
    const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri') || '';
    const match = redirectUri.match(/\/api\/actions\/([^/]+)\/oauth\/callback/);
    return match?.[1] || '';
  }, [parsedAuthUrl, isMCPToolCall]);

  const handleOAuthClick = useCallback(async () => {
    if (!auth) {
      return;
    }
    try {
      if (isMCPToolCall && mcpServerName) {
        await dataService.bindMCPOAuth(mcpServerName);
      } else if (actionId) {
        await dataService.bindActionOAuth(actionId);
      }
    } catch (e) {
      logger.error('Failed to bind OAuth CSRF cookie', e);
    }
    window.open(auth, '_blank', 'noopener,noreferrer');
  }, [auth, isMCPToolCall, mcpServerName, actionId]);

  const hasError = typeof output === 'string' && isError(output);
  const cancelled = !isSubmitting && initialProgress < 1 && !hasError;
  const errorState = hasError;

  const args = useMemo(() => {
    if (typeof _args === 'string') {
      return _args;
    }
    try {
      return JSON.stringify(_args, null, 2);
    } catch (e) {
      logger.error(
        'client/src/components/Chat/Messages/Content/ToolCall.tsx - Failed to stringify args',
        e,
      );
      return '';
    }
  }, [_args]) as string | undefined;

  const hasInfo = useMemo(
    () => (args?.length ?? 0) > 0 || (output?.length ?? 0) > 0,
    [args, output],
  );

  const hasImageAttachment = useMemo(() => {
    if (!attachments || attachments.length === 0) {
      return false;
    }
    return attachments.some((attachment) => {
      const filename = attachment.filename ?? '';
      const { width, height, filepath = null } = attachment as { width?: number; height?: number; filepath?: string | null };
      return (
        Boolean(filepath) &&
        width != null &&
        height != null &&
        imageExtRegex.test(filename.toLowerCase())
      );
    });
  }, [attachments]);

  const isImageLikeTool = useMemo(() => {
    const lowerName = typeof name === 'string' ? name.toLowerCase() : '';
    const argsString = typeof _args === 'string' ? _args.toLowerCase() : '';
    const keywords = ['image', 'img', 'flux', 'dalle', 'sd', 'sdxl', 'photo', 'picture', 'imagen'];
    return keywords.some((kw) => lowerName.includes(kw) || argsString.includes(kw));
  }, [name, _args]);

  const authDomain = useMemo(() => {
    return parsedAuthUrl?.hostname ?? '';
  }, [parsedAuthUrl]);

  const progress = useProgress(initialProgress);
  const showCancelled = cancelled || (errorState && !output);

  const subtitle = useMemo(() => {
    if (isMCPToolCall && mcpServerName) {
      return localize('com_ui_via_server', { 0: mcpServerName });
    }
    if (domain && domain.length !== Constants.ENCODED_DOMAIN_LENGTH) {
      return localize('com_ui_via_server', { 0: domain });
    }
    return undefined;
  }, [isMCPToolCall, mcpServerName, domain, localize]);

  const showImagePlaceholder = isSubmitting && progress < 1 && isImageLikeTool && !hasImageAttachment;

  const getFinishedText = () => {
    if (cancelled) {
      return localize('com_ui_cancelled');
    }
    if (isMCPToolCall === true) {
      return localize('com_assistants_completed_function', { 0: function_name });
    }
    if (domain != null && domain && domain.length !== Constants.ENCODED_DOMAIN_LENGTH) {
      return localize('com_assistants_completed_action', { 0: domain });
    }
    return localize('com_assistants_completed_function', { 0: function_name });
  };

  if (!isLast && (!function_name || function_name.length === 0) && !output) {
    return null;
  }

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {(() => {
          if (progress < 1 && !showCancelled) {
            return function_name
              ? localize('com_assistants_running_var', { 0: function_name })
              : localize('com_assistants_running_action');
          }
          return getFinishedText();
        })()}
      </span>
      <div className="relative my-1.5 flex h-5 shrink-0 items-center gap-2.5">
        <ProgressText
          progress={progress}
          onClick={() => setShowInfo((prev) => !prev)}
          inProgressText={
            function_name
              ? localize('com_assistants_running_var', { 0: function_name })
              : localize('com_assistants_running_action')
          }
          authText={
            !showCancelled && authDomain.length > 0 ? localize('com_ui_requires_auth') : undefined
          }
          finishedText={getFinishedText()}
          subtitle={subtitle}
          errorSuffix={errorState && !cancelled ? localize('com_ui_tool_failed') : undefined}
          icon={
            <ToolIcon
              type={toolIconType}
              iconUrl={mcpIconUrl}
              isAnimating={progress < 1 && !showCancelled && !errorState}
            />
          }
          hasInput={hasInfo}
          isExpanded={showInfo}
          error={showCancelled}
        />
      </div>
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          {hasInfo && (
            <div className="my-2 overflow-hidden rounded-lg border border-border-light bg-surface-secondary">
              <ToolCallInfo input={args ?? ''} output={output} attachments={attachments} />
            </div>
          )}
        </div>
      </div>
      {auth != null && auth && progress < 1 && !showCancelled && (
        <div className="flex w-full flex-col gap-2.5">
          <div className="mb-1 mt-2">
            <Button
              className="inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium"
              variant="default"
              rel="noopener noreferrer"
              onClick={handleOAuthClick}
            >
              {localize('com_ui_sign_in_to_domain', { 0: authDomain })}
            </Button>
          </div>
          <p className="flex items-center text-xs text-text-warning">
            <TriangleAlert className="mr-1.5 inline-block h-4 w-4" aria-hidden="true" />
            {localize('com_assistants_allow_sites_you_trust')}
          </p>
        </div>
      )}
      {!hideAttachments && showImagePlaceholder && (
        <div className="my-3 flex max-w-lg items-center gap-3 rounded-xl border border-border-light bg-surface-secondary p-3 shadow-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-primary">
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-text-primary">Generating image...</p>
            <Skeleton className="mt-2 h-24 w-full rounded-lg" />
          </div>
        </div>
      )}
      {!hideAttachments && attachments && attachments.length > 0 && (
        <AttachmentGroup attachments={attachments} />
      )}
    </>
  );
}
