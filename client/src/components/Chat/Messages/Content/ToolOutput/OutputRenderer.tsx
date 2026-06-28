import { useState, useMemo, useEffect, useCallback } from 'react';
import copy from 'copy-to-clipboard';
import { request } from 'librechat-data-provider';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface ContentBlock {
  type?: string;
  text?: string;
}

const ERROR_PREFIX = /^Error:\s*(\[.*?\]\s*)*tool call failed:\s*/i;
const ERROR_INNER = /^Error\s+\w+ing to endpoint\s*\(HTTP \d+\):\s*/i;

function cleanError(text: string): string {
  let cleaned = text.replace(ERROR_PREFIX, '').trim();
  cleaned = cleaned.replace(ERROR_INNER, '').trim();
  if (cleaned.endsWith('Please fix your mistakes.')) {
    cleaned = cleaned.slice(0, -'Please fix your mistakes.'.length).trim();
  }
  return cleaned;
}

export function isError(text: string): boolean {
  return ERROR_PREFIX.test(text) || text.startsWith('Error processing tool');
}

function isStructuredText(text: string): boolean {
  return text.includes('\n') || text.includes('{') || text.includes(':');
}

interface ExtractedText {
  text: string;
  rawError: string;
  error: boolean;
  /** When true, `text` contains raw JSON that should be rendered as a highlighted code block. */
  isJson: boolean;
}

type BrowserTaskResult = {
  sessionId: string;
  status?: string;
  summary?: string;
  currentUrl?: string;
  screenshotPath?: string;
  viewerUrl?: string;
  hasLiveViewer?: boolean;
  telemetryError?: string;
};

type BrowserSessionState = {
  sessionId: string;
  status?: string;
  summary?: string;
  currentUrl?: string;
  lastAction?: string;
  hasScreenshot?: boolean;
  updatedAt?: string;
};

type ScreenshotResponse = {
  data: Blob;
};

const terminalBrowserStatuses = new Set(['completed', 'failed', 'stopped']);

function parseBrowserTaskResult(text: string): BrowserTaskResult | null {
  try {
    const parsed = JSON.parse(text) as Partial<BrowserTaskResult>;
    if (typeof parsed.sessionId !== 'string') {
      return null;
    }
    return parsed as BrowserTaskResult;
  } catch {
    return null;
  }
}

function BrowserSessionCard({ result }: { result: BrowserTaskResult }) {
  const localize = useLocalize();
  const [session, setSession] = useState<BrowserSessionState | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(result.telemetryError ?? null);

  const status = session?.status ?? result.status ?? 'unknown';
  const currentUrl = session?.currentUrl ?? result.currentUrl;
  const summary = session?.summary ?? result.summary;
  const lastAction = session?.lastAction;
  const canStop = result.hasLiveViewer === true && !terminalBrowserStatuses.has(status);

  const loadScreenshot = useCallback(async () => {
    const response = await request.getResponse<ScreenshotResponse>(
      `/api/browser-sessions/${encodeURIComponent(result.sessionId)}/screenshot`,
      { responseType: 'blob' },
    );
    const nextUrl = URL.createObjectURL(response.data);
    setScreenshotUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return nextUrl;
    });
  }, [result.sessionId]);

  const loadSession = useCallback(async () => {
    if (result.hasLiveViewer !== true) {
      return null;
    }
    const nextSession = await request.get<BrowserSessionState>(
      `/api/browser-sessions/${encodeURIComponent(result.sessionId)}`,
    );
    setSession(nextSession);
    setError(null);
    if (nextSession.hasScreenshot) {
      await loadScreenshot();
    }
    return nextSession;
  }, [loadScreenshot, result.hasLiveViewer, result.sessionId]);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof window.setInterval> | undefined;

    const refresh = async () => {
      try {
        const nextSession = await loadSession();
        if (!nextSession || cancelled || !terminalBrowserStatuses.has(nextSession.status ?? '')) {
          return;
        }
        if (interval) {
          window.clearInterval(interval);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : localize('com_ui_error'));
        }
      }
    };

    refresh();
    if (result.hasLiveViewer === true && !terminalBrowserStatuses.has(status)) {
      interval = window.setInterval(refresh, 2500);
    }

    return () => {
      cancelled = true;
      if (interval) {
        window.clearInterval(interval);
      }
    };
  }, [loadSession, localize, result.hasLiveViewer, status]);

  useEffect(() => {
    return () => {
      if (screenshotUrl) {
        URL.revokeObjectURL(screenshotUrl);
      }
    };
  }, [screenshotUrl]);

  const handleStop = useCallback(async () => {
    await request.post(`/api/browser-sessions/${encodeURIComponent(result.sessionId)}/stop`, {});
    await loadSession();
  }, [loadSession, result.sessionId]);

  return (
    <div className="rounded-md border border-border-light bg-surface-secondary p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-medium text-text-primary">
          {localize('com_agents_browser_session')}
        </div>
        <span className="rounded bg-surface-tertiary px-2 py-0.5 text-xs text-text-secondary">
          {status}
        </span>
      </div>
      {summary && <p className="mb-2 text-text-primary">{summary}</p>}
      {lastAction && (
        <p className="mb-2 text-xs text-text-secondary">
          {localize('com_agents_browser_last_action')}: {lastAction}
        </p>
      )}
      {screenshotUrl && (
        <img
          className="mb-2 max-h-80 w-full rounded border border-border-light object-contain"
          src={screenshotUrl}
          alt={localize('com_agents_browser_live_preview')}
        />
      )}
      {currentUrl && (
        <p className="truncate text-xs text-text-secondary" title={currentUrl}>
          {currentUrl}
        </p>
      )}
      {!screenshotUrl && result.screenshotPath && (
        <p className="mt-1 truncate text-xs text-text-secondary" title={result.screenshotPath}>
          {localize('com_agents_browser_screenshot')}: {result.screenshotPath}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {result.hasLiveViewer === true && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="rounded border border-border-medium px-2 py-1 text-xs text-text-primary hover:bg-surface-tertiary"
            onClick={loadSession}
          >
            {localize('com_ui_refresh')}
          </button>
          {canStop && (
            <button
              type="button"
              className="rounded border border-border-medium px-2 py-1 text-xs text-text-primary hover:bg-surface-tertiary"
              onClick={handleStop}
            >
              {localize('com_ui_stop')}
            </button>
          )}
        </div>
      )}
      {result.viewerUrl && (
        <a
          className="mt-2 inline-block text-sm underline"
          href={result.viewerUrl}
          target="_blank"
          rel="noreferrer"
        >
          {localize('com_agents_browser_open_viewer')}
        </a>
      )}
    </div>
  );
}

function extractText(raw: string): ExtractedText {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', rawError: '', error: false, isJson: false };
  }

  if (isError(trimmed)) {
    return { text: cleanError(trimmed), rawError: trimmed, error: true, isJson: false };
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const textBlocks = parsed.filter(
          (b: ContentBlock) => typeof b === 'object' && b !== null && typeof b.text === 'string',
        );
        if (textBlocks.length > 0) {
          const joined = (textBlocks as ContentBlock[])
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (isError(joined)) {
            return { text: cleanError(joined), rawError: joined, error: true, isJson: false };
          }
          return { text: joined, rawError: '', error: false, isJson: false };
        }
      }

      // Render structured JSON as a highlighted code block
      return {
        text: JSON.stringify(parsed, null, 2),
        rawError: '',
        error: false,
        isJson: true,
      };
    } catch {
      // Not JSON
    }
  }

  return { text: trimmed, rawError: '', error: false, isJson: false };
}

const TRUNCATE_LINES = 20;
const VISIBLE_LINES = 15;

interface OutputRendererProps {
  text: string;
}

export default function OutputRenderer({ text }: OutputRendererProps) {
  const localize = useLocalize();
  const { text: displayText, rawError, error, isJson } = useMemo(() => extractText(text), [text]);
  const browserTaskResult = useMemo(() => parseBrowserTaskResult(displayText), [displayText]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = useCallback(() => {
    setIsCopied(true);
    copy(displayText, { format: 'text/plain' });
    setTimeout(() => setIsCopied(false), 3000);
  }, [displayText]);

  if (!displayText) {
    return null;
  }

  if (browserTaskResult) {
    return <BrowserSessionCard result={browserTaskResult} />;
  }

  const lines = displayText.split('\n');
  const needsTruncation = lines.length > TRUNCATE_LINES;
  const visibleText =
    needsTruncation && !isExpanded ? lines.slice(0, VISIBLE_LINES).join('\n') : displayText;
  const structured = !isJson && isStructuredText(displayText);

  return (
    <div className="relative">
      {isJson ? (
        <pre className="max-h-[300px] overflow-auto rounded text-xs">
          <code className="hljs language-json !whitespace-pre-wrap !break-words">
            {visibleText}
          </code>
        </pre>
      ) : (
        <pre
          className={cn(
            'max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-xs',
            error && 'font-mono text-red-600 dark:text-red-400',
            !error && structured && 'font-mono text-text-secondary',
            !error && !structured && 'font-sans text-sm text-text-primary',
          )}
        >
          {visibleText}
        </pre>
      )}
      <div className="absolute bottom-0 right-0">
        <CopyButton
          isCopied={isCopied}
          onClick={handleCopy}
          iconOnly
          label={localize('com_ui_copy')}
        />
      </div>
      {needsTruncation && (
        <button
          type="button"
          className="mt-1 text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          {isExpanded ? localize('com_ui_show_less') : localize('com_ui_show_more')}
        </button>
      )}
      {error && rawError && rawError !== displayText && (
        <button
          type="button"
          className="mt-1 block text-xs text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          onClick={() => setShowErrorDetails((prev) => !prev)}
        >
          {localize('com_ui_details')}
        </button>
      )}
      {showErrorDetails && rawError && (
        <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-red-600 dark:text-red-400">
          {rawError}
        </pre>
      )}
    </div>
  );
}
