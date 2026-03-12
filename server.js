import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const MAX_BODY_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30000;
const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map();

/*
Session shape:
{
  browser,
  context,
  page,
  createdAt,
  lastUsedAt
}
*/

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function now() {
  return Date.now();
}

function touchSession(session) {
  session.lastUsedAt = now();
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  try {
    await session.page.close().catch(() => {});
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  } finally {
    sessions.delete(sessionId);
  }
  return true;
}

async function cleanupExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  const ids = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (session.lastUsedAt < cutoff) ids.push(sessionId);
  }
  for (const sessionId of ids) {
    await closeSession(sessionId);
  }
}

setInterval(() => {
  cleanupExpiredSessions().catch(() => {});
}, 60_000);

async function createSession(startUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 2560 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

  if (startUrl) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  }

  const sessionId = randomUUID();
  const session = {
    browser,
    context,
    page,
    createdAt: now(),
    lastUsedAt: now()
  };
  sessions.set(sessionId, session);

  return { sessionId, session };
}

function getSessionOrThrow(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId");
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Invalid sessionId");
  touchSession(session);
  return session;
}

async function getOrCreatePage(body) {
  if (body.sessionId) {
    const session = getSessionOrThrow(body.sessionId);
    return {
      sessionId: body.sessionId,
      session,
      page: session.page,
      created: false
    };
  }

  const { sessionId, session } = await createSession(body.url);
  return {
    sessionId,
    session,
    page: session.page,
    created: true
  };
}

async function ensureUrl(page, url) {
  if (!url) return;
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

async function pageSnapshot(page) {
  const title = await page.title();
  const url = page.url();
  return { title, url };
}

async function safeInnerText(page, selector = "body", maxLength = 12000) {
  const text = await page.locator(selector).innerText();
  return text.slice(0, maxLength);
}

async function waitForOptional(page, selector, timeout = 5000) {
  try {
    await page.locator(selector).waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function fillOneField(page, field) {
  const { selector, type = "text", value, checked, filePaths } = field;
  if (!selector) throw new Error("Each field must include selector");

  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });

  switch (type) {
    case "text":
    case "email":
    case "password":
    case "textarea":
      await locator.fill(String(value ?? ""));
      break;

    case "select":
      await locator.selectOption(String(value ?? ""));
      break;

    case "checkbox": {
      const shouldCheck = Boolean(checked);
      if (shouldCheck) {
        await locator.check();
      } else {
        await locator.uncheck();
      }
      break;
    }

    case "radio":
      await locator.check();
      break;

    case "file":
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error(`Field ${selector} requires filePaths`);
      }
      await locator.setInputFiles(filePaths);
      break;

    default:
      throw new Error(`Unsupported field type: ${type}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { method, url } = req;

    if (method === "GET" && url === "/") {
      return sendJson(res, 200, {
        ok: true,
        service: "playwright-api",
        sessions: sessions.size
      });
    }

    if (method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, sessions: sessions.size });
    }

    if (method === "POST" && url === "/session/start") {
      const body = await readBody(req);
      const { sessionId, session } = await createSession(body.url);
      const snapshot = await pageSnapshot(session.page);
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot
      });
    }

    if (method === "POST" && url === "/session/close") {
      const body = await readBody(req);
      const closed = await closeSession(body.sessionId);
      return sendJson(res, 200, { ok: true, closed });
    }

    if (method === "POST" && url === "/open") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      const snapshot = await pageSnapshot(page);
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot
      });
    }

    if (method === "POST" && url === "/title") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      const snapshot = await pageSnapshot(page);
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot
      });
    }

    if (method === "POST" && url === "/extract") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      if (body.waitForSelector) {
        await page.locator(body.waitForSelector).first().waitFor({
          state: "visible",
          timeout: DEFAULT_TIMEOUT_MS
        });
      }

      const snapshot = await pageSnapshot(page);
      const text = await safeInnerText(
        page,
        body.selector || "body",
        Number(body.maxLength || 12000)
      );

      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot,
        text
      });
    }

    if (method === "POST" && url === "/click") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      if (!body.selector) {
        return sendJson(res, 400, { ok: false, error: "Missing selector" });
      }

      const locator = page.locator(body.selector).first();
      await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
      await locator.click();

      if (body.waitForNavigation) {
        await page.waitForLoadState("domcontentloaded");
      }

      if (body.waitForSelector) {
        await page.locator(body.waitForSelector).first().waitFor({
          state: "visible",
          timeout: DEFAULT_TIMEOUT_MS
        });
      }

      const snapshot = await pageSnapshot(page);
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot
      });
    }

    if (method === "POST" && url === "/fill-form") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      if (!Array.isArray(body.fields) || body.fields.length === 0) {
        return sendJson(res, 400, {
          ok: false,
          error: "Missing fields array"
        });
      }

      for (const field of body.fields) {
        await fillOneField(page, field);
      }

      const snapshot = await pageSnapshot(page);
      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot,
        filledCount: body.fields.length
      });
    }

    if (method === "POST" && url === "/prepare-submit") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      if (Array.isArray(body.fields) && body.fields.length > 0) {
        for (const field of body.fields) {
          await fillOneField(page, field);
        }
      }

      if (body.preSubmitClickSelector) {
        const locator = page.locator(body.preSubmitClickSelector).first();
        await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
        await locator.click();
      }

      if (body.waitForSelector) {
        await page.locator(body.waitForSelector).first().waitFor({
          state: "visible",
          timeout: DEFAULT_TIMEOUT_MS
        });
      }

      const snapshot = await pageSnapshot(page);
      const previewText = await safeInnerText(
        page,
        body.previewSelector || "body",
        Number(body.maxLength || 6000)
      );

      return sendJson(res, 200, {
        ok: true,
        sessionId,
        ...snapshot,
        previewText,
        readyToConfirm: true
      });
    }

    if (method === "POST" && url === "/screenshot") {
      const body = await readBody(req);
      const { sessionId, page } = await getOrCreatePage(body);

      if (body.url) {
        await ensureUrl(page, body.url);
      }

      if (body.waitForSelector) {
        await page.locator(body.waitForSelector).first().waitFor({
          state: "visible",
          timeout: DEFAULT_TIMEOUT_MS
        });
      }

      const png = await page.screenshot({
        fullPage: body.fullPage !== false,
        type: "png"
      });

      res.writeHead(200, {
        "Content-Type": "image/png",
        "X-Session-Id": sessionId
      });
      return res.end(png);
    }

    if (method === "GET" && url === "/sessions") {
      const items = [...sessions.entries()].map(([sessionId, session]) => ({
        sessionId,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        currentUrl: session.page.url()
      }));
      return sendJson(res, 200, { ok: true, sessions: items });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Playwright API listening on ${HOST}:${PORT}`);
});
