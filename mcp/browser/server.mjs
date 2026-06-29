#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright';
import { z } from 'zod';

const sessions = new Map();
const storageDir = process.env.BROWSER_STORAGE_DIR || path.join(process.cwd(), 'state');
const apiBaseUrl = process.env.LIBRECHAT_API_BASE_URL?.replace(/\/$/, '');
const internalToken = process.env.BROWSER_INTERNAL_TOKEN;
const allowedOrigins = new Set(
  (process.env.BROWSER_ALLOWED_ORIGINS || '')
    .split(/[;,]/)
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function normalizeOrigin(value) {
  return new URL(value).origin;
}

function assertAllowed(url) {
  if (allowedOrigins.size === 0) {
    return;
  }
  const origin = normalizeOrigin(url);
  if (!allowedOrigins.has(origin)) {
    throw new Error(`Browser origin is not allowed: ${origin}`);
  }
}

function sameUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return left === right;
  }
}

function toTextContent(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function getCredentialStatus(credential, login) {
  if (!credential) {
    return {
      available: false,
    };
  }

  return {
    available: true,
    credentialId: credential.id,
    origin: credential.origin,
    loginUrl: credential.loginUrl,
    usernameSet: Boolean(credential.username),
    passwordSet: Boolean(credential.password),
    selectorsConfigured: Boolean(credential.usernameSelector && credential.passwordSelector),
    loginAttempted: login?.attempted === true,
    loginSucceeded: login?.succeeded === true,
    usernameSelectorDetected: Boolean(login?.usernameSelector),
    passwordSelectorDetected: Boolean(login?.passwordSelector),
    submitSelectorDetected: Boolean(login?.submitSelector),
  };
}

async function firstVisibleSelector(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    if (await locator.isVisible().catch(() => false)) {
      return selector;
    }
  }
  return null;
}

async function getLoginSelectors(page, credential) {
  const usernameSelector =
    credential.usernameSelector ||
    (await firstVisibleSelector(page, [
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name="nev" i]',
      'input[name="username" i]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[name*="login" i]',
      'input[name*="nick" i]',
      'input[placeholder*="felhaszn" i]',
      'input[placeholder*="username" i]',
      'input[id*="email" i]',
      'input[id*="user" i]',
      'input[id*="login" i]',
      'input[type="text"]',
      'input:not([type])',
    ]));
  const passwordSelector =
    credential.passwordSelector ||
    (await firstVisibleSelector(page, [
      'input[autocomplete="current-password"]',
      'input[type="password"]',
      'input[name="pass" i]',
      'input[name="password" i]',
      'input[name*="pass" i]',
      'input[placeholder*="jelsz" i]',
      'input[placeholder*="password" i]',
      'input[id*="pass" i]',
    ]));

  return {
    usernameSelector,
    passwordSelector,
  };
}

async function getSubmitSelector(page, credential) {
  return (
    credential.submitSelector ||
    (await firstVisibleSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Bejelentkezés")',
      'input[value*="Log in" i]',
      'input[value*="Login" i]',
      'input[value*="Sign in" i]',
      'input[value*="Bejelentkezés" i]',
      'form button',
      'form input[type="button"]',
    ]))
  );
}

async function selectorMatches(page, selector, candidate) {
  return await page
    .locator(selector)
    .first()
    .evaluate((element, candidateSelector) => {
      try {
        return element.matches(candidateSelector);
      } catch {
        return false;
      }
    }, candidate)
    .catch(() => false);
}

async function selectorTargetsSameElement(page, selector, candidate) {
  if (!candidate) {
    return false;
  }
  return await page
    .locator(selector)
    .first()
    .evaluate((element, candidateSelector) => {
      try {
        return Array.from(document.querySelectorAll(candidateSelector)).includes(element);
      } catch {
        return false;
      }
    }, candidate)
    .catch(() => false);
}

async function getCredentialFillValue(page, selector, loginContext) {
  const { credential, usernameSelector, passwordSelector } = loginContext ?? {};
  if (!credential?.username || !credential?.password) {
    return null;
  }

  const isPasswordTarget =
    (await selectorTargetsSameElement(page, selector, passwordSelector)) ||
    (await selectorMatches(
      page,
      selector,
      [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[name*="pass" i]',
        'input[id*="pass" i]',
        'input[placeholder*="jelsz" i]',
        'input[placeholder*="password" i]',
      ].join(','),
    ));
  if (isPasswordTarget) {
    return {
      field: 'password',
      value: credential.password,
    };
  }

  const isUsernameTarget =
    (await selectorTargetsSameElement(page, selector, usernameSelector)) ||
    (await selectorMatches(
      page,
      selector,
      [
        'input[autocomplete="username"]',
        'input[type="email"]',
        'input[name="nev" i]',
        'input[name="username" i]',
        'input[name*="email" i]',
        'input[name*="user" i]',
        'input[name*="login" i]',
        'input[name*="nick" i]',
        'input[id*="email" i]',
        'input[id*="user" i]',
        'input[id*="login" i]',
        'input[placeholder*="felhaszn" i]',
        'input[placeholder*="username" i]',
      ].join(','),
    ));
  if (isUsernameTarget) {
    return {
      field: 'username',
      value: credential.username,
    };
  }

  return null;
}

async function internalFetch(pathname, init) {
  if (!apiBaseUrl || !internalToken) {
    return null;
  }

  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-browser-internal-token': internalToken,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Browser session API failed: ${text}`);
  }

  return response.json();
}

async function fetchAgentCredential({ agentId, origin, credentialId }) {
  if (!apiBaseUrl || !internalToken || !agentId || (!origin && !credentialId)) {
    return null;
  }

  const response = await fetch(`${apiBaseUrl}/api/browser-sessions/credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-browser-internal-token': internalToken,
    },
    body: JSON.stringify({ agentId, origin, credentialId }),
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Credential lookup failed: ${text}`);
  }
  return response.json();
}

async function saveScreenshot(page, sessionId) {
  await mkdir(storageDir, { recursive: true });
  const filePath = path.join(storageDir, `${sessionId}.png`);
  const buffer = await page.screenshot({ fullPage: true });
  await writeFile(filePath, buffer);
  return {
    filePath,
    base64: buffer.toString('base64'),
  };
}

async function createBackendSession(input) {
  const agentId = input.agentId || process.env.BROWSER_AGENT_ID || undefined;
  try {
    return await internalFetch('/api/browser-sessions/internal', {
      method: 'POST',
      body: JSON.stringify({
        userId: input.userId || process.env.BROWSER_USER_ID || undefined,
        agentId,
        conversationId: input.conversationId || process.env.BROWSER_CONVERSATION_ID || undefined,
        startUrl: input.startUrl,
      }),
    });
  } catch (error) {
    return {
      telemetryError: error instanceof Error ? error.message : 'Browser session API failed',
    };
  }
}

async function updateBackendSession(sessionId, update) {
  try {
    return await internalFetch(`/api/browser-sessions/internal/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    });
  } catch {
    return null;
  }
}

async function getBackendSession(sessionId) {
  try {
    return await internalFetch(`/api/browser-sessions/internal/${sessionId}`, {
      method: 'GET',
    });
  } catch {
    return null;
  }
}

class BrowserTaskStopped extends Error {
  constructor() {
    super('Browser task was stopped by user');
  }
}

function requireSelector(step) {
  if (!step.selector) {
    throw new Error(`${step.action} requires selector`);
  }
  return step.selector;
}

function requireValue(step, field) {
  const value = step[field];
  if (!value) {
    throw new Error(`${step.action} requires ${field}`);
  }
  return value;
}

async function runBrowserStep(page, step, mode, loginContext) {
  const timeout = step.timeoutMs ?? 30000;

  if (step.action === 'goto') {
    const url = requireValue(step, 'url');
    assertAllowed(url);
    await page.goto(url, { waitUntil: step.waitUntil ?? 'domcontentloaded', timeout });
    return null;
  }

  if (step.action === 'click') {
    await page.click(requireSelector(step), { timeout });
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
    return null;
  }

  if (step.action === 'fill') {
    if (mode !== 'interactive') {
      throw new Error('fill steps require interactive mode');
    }
    const selector = requireSelector(step);
    const credentialFill = await getCredentialFillValue(page, selector, loginContext);
    await page.fill(selector, credentialFill?.value ?? requireValue(step, 'value'), { timeout });
    return null;
  }

  if (step.action === 'press') {
    if (mode !== 'interactive') {
      throw new Error('press steps require interactive mode');
    }
    if (step.selector) {
      await page.locator(step.selector).press(requireValue(step, 'key'), { timeout });
    } else {
      await page.keyboard.press(requireValue(step, 'key'));
    }
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
    return null;
  }

  if (step.action === 'wait_for_selector') {
    await page.waitForSelector(requireSelector(step), { timeout });
    return null;
  }

  if (step.action === 'wait_for_load') {
    await page.waitForLoadState(step.waitUntil ?? 'networkidle', { timeout });
    return null;
  }

  if (step.action === 'wait') {
    await page.waitForTimeout(Math.min(timeout, 60000));
    return null;
  }

  if (step.action === 'extract_text') {
    const locator = step.selector ? page.locator(step.selector).first() : page.locator('body');
    const text = await locator.innerText({ timeout });
    return {
      action: step.action,
      selector: step.selector,
      text: text.slice(0, step.textLimit ?? 4000),
    };
  }

  if (step.action === 'screenshot') {
    return null;
  }

  throw new Error(`Unsupported browser step: ${step.action}`);
}

const browserStepSchema = z.object({
  action: z.enum([
    'goto',
    'click',
    'fill',
    'press',
    'wait',
    'wait_for_selector',
    'wait_for_load',
    'extract_text',
    'screenshot',
  ]),
  url: z.string().url().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120000).optional(),
  textLimit: z.number().int().positive().max(20000).optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
});

const server = new McpServer({
  name: 'madchat-browser',
  version: '0.1.0',
});

server.tool(
  'browser_task',
  {
    task: z.string(),
    startUrl: z.string().url(),
    agentId: z.string().optional(),
    userId: z.string().optional(),
    conversationId: z.string().optional(),
    mode: z.enum(['read_only', 'interactive']).optional().default('read_only'),
    credentialId: z
      .string()
      .optional()
      .describe('Safe saved credential handle. Never place usernames or passwords here.'),
    credentialOrigin: z
      .string()
      .url()
      .optional()
      .describe(
        'Website origin for selecting a saved credential, for example https://example.com.',
      ),
    maxSteps: z.number().int().positive().max(100).optional().default(20),
    sessionVisible: z.boolean().optional().default(true),
    steps: z.array(browserStepSchema).optional().default([]),
  },
  async (input) => {
    assertAllowed(input.startUrl);
    const agentId = input.agentId || process.env.BROWSER_AGENT_ID || undefined;
    const credentialOrigin = input.credentialOrigin
      ? normalizeOrigin(input.credentialOrigin)
      : normalizeOrigin(input.startUrl);
    const credential = await fetchAgentCredential({
      agentId,
      origin: credentialOrigin,
      credentialId: input.credentialId || undefined,
    });
    if (credential?.loginUrl) {
      assertAllowed(credential.loginUrl);
    }

    const backendSession = await createBackendSession(input);
    const sessionId = backendSession?.sessionId || randomUUID();
    const launchOptions = { headless: process.env.BROWSER_HEADLESS !== 'false' };
    if (process.env.BROWSER_NO_SANDBOX === 'true') {
      launchOptions.args = ['--no-sandbox', '--disable-setuid-sandbox'];
    }
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = {
      sessionId,
      status: 'running',
      task: input.task,
      currentUrl: input.startUrl,
      lastAction: 'Opening start URL',
      startedAt: new Date().toISOString(),
      screenshotPath: undefined,
      telemetryError: backendSession?.telemetryError,
    };
    sessions.set(sessionId, session);

    const publish = async (update) => {
      const { screenshot, ...safeUpdate } = update;
      Object.assign(session, safeUpdate, {
        ...(screenshot ? { hasScreenshot: true } : {}),
      });
      if (!apiBaseUrl || !internalToken || backendSession?.telemetryError) {
        return;
      }
      await updateBackendSession(sessionId, update);
    };

    const capture = async (lastAction) => {
      const screenshot = await saveScreenshot(page, sessionId);
      session.screenshotPath = screenshot.filePath;
      await publish({
        status: session.status,
        currentUrl: page.url(),
        lastAction,
        screenshot: screenshot.base64,
      });
      return screenshot.filePath;
    };

    const assertNotStopped = async () => {
      if (!apiBaseUrl || !internalToken || backendSession?.telemetryError) {
        return;
      }
      const backendStatus = await getBackendSession(sessionId);
      if (backendStatus?.status === 'stopped') {
        throw new BrowserTaskStopped();
      }
    };

    const login = {
      attempted: false,
      succeeded: false,
      usernameSelector: undefined,
      passwordSelector: undefined,
      submitSelector: undefined,
    };
    let loginContext = null;

    try {
      await publish({
        status: 'running',
        currentUrl: input.startUrl,
        lastAction: credential?.loginUrl ? 'Opening configured login URL' : 'Opening start URL',
      });
      await page.goto(credential?.loginUrl || input.startUrl, { waitUntil: 'domcontentloaded' });
      await publish({ currentUrl: page.url() });

      if (credential?.username && credential?.password) {
        const { usernameSelector, passwordSelector } = await getLoginSelectors(page, credential);
        const submitSelector = await getSubmitSelector(page, credential);
        login.usernameSelector = usernameSelector;
        login.passwordSelector = passwordSelector;
        login.submitSelector = submitSelector;
        loginContext = {
          credential,
          usernameSelector,
          passwordSelector,
        };
        if (!usernameSelector || !passwordSelector) {
          await publish({
            currentUrl: page.url(),
            lastAction: 'Credential found but login fields were not detected',
          });
        } else {
          login.attempted = true;
          await publish({
            currentUrl: page.url(),
            lastAction: 'Submitting configured login form',
          });
          await page.fill(usernameSelector, credential.username);
          await page.fill(passwordSelector, credential.password);
          if (submitSelector) {
            await page.click(submitSelector);
          } else {
            await page.keyboard.press('Enter');
          }
          if (credential.successSelector) {
            await page.waitForSelector(credential.successSelector, { timeout: 30000 });
          } else {
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
          }
          login.succeeded = !(await page
            .locator(passwordSelector)
            .first()
            .isVisible()
            .catch(() => false));
          await publish({
            currentUrl: page.url(),
            lastAction: login.succeeded
              ? 'Configured login completed'
              : 'Configured login submitted but login form is still visible',
          });
        }
      }

      const shouldOpenTaskStartUrl =
        !credential?.loginUrl || !sameUrl(input.startUrl, credential.loginUrl);
      if (shouldOpenTaskStartUrl && page.url() !== input.startUrl) {
        assertAllowed(input.startUrl);
        await publish({ currentUrl: page.url(), lastAction: 'Opening task start URL' });
        await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' });
      }

      const extracts = [];
      const steps = input.steps.slice(0, input.maxSteps);
      if (steps.length === 0) {
        const title = await page.title().catch(() => '');
        const text = await page
          .locator('body')
          .innerText({ timeout: 10000 })
          .catch(() => '');
        extracts.push({
          action: 'extract_text',
          selector: 'body',
          title,
          text: text.slice(0, 4000),
        });
      }

      for (let index = 0; index < steps.length; index += 1) {
        await assertNotStopped();
        const step = steps[index];
        const lastAction = `Step ${index + 1}/${steps.length}: ${step.action}`;
        await publish({ status: 'running', currentUrl: page.url(), lastAction });
        const extract = await runBrowserStep(page, step, input.mode, loginContext);
        if (extract) {
          extracts.push({ ...extract, step: index + 1 });
        }
        if (input.sessionVisible || step.action === 'screenshot') {
          await capture(lastAction);
        } else {
          await publish({ currentUrl: page.url(), lastAction });
        }
      }

      session.currentUrl = page.url();
      session.status = 'completed';
      const finalScreenshotPath = await capture('Browser task completed');
      const summary = `Browser task completed in one tool call with ${steps.length} explicit step${
        steps.length === 1 ? '' : 's'
      }.`;
      await publish({
        status: 'completed',
        currentUrl: page.url(),
        lastAction: 'Browser task completed',
        summary,
      });
      await browser.close();

      return toTextContent({
        sessionId,
        status: 'completed',
        summary,
        currentUrl: session.currentUrl,
        credential: getCredentialStatus(credential, login),
        screenshotPath: finalScreenshotPath,
        hasLiveViewer: Boolean(apiBaseUrl && internalToken && !backendSession?.telemetryError),
        telemetryError: session.telemetryError,
        extracts,
      });
    } catch (error) {
      const stopped = error instanceof BrowserTaskStopped;
      session.status = stopped ? 'stopped' : 'failed';
      session.lastAction = error instanceof Error ? error.message : 'Browser task failed';
      await publish({
        status: session.status,
        currentUrl: page.url(),
        lastAction: session.lastAction,
        summary: session.lastAction,
      });
      if (!stopped) {
        await capture(session.lastAction).catch(() => undefined);
      }
      await browser.close().catch(() => undefined);
      return toTextContent({
        sessionId,
        status: session.status,
        summary: session.lastAction,
        currentUrl: page.url(),
        credential: getCredentialStatus(credential, login),
        hasLiveViewer: Boolean(apiBaseUrl && internalToken && !backendSession?.telemetryError),
        telemetryError: session.telemetryError,
      });
    }
  },
);

await server.connect(new StdioServerTransport());
