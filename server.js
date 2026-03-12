import http from "node:http";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 8080);

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
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

async function withBrowser(task) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    return await task(page);
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      return sendJson(res, 200, { ok: true, service: "playwright-api" });
    }

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/title") {
      const { url } = await readBody(req);
      if (!url) {
        return sendJson(res, 400, { ok: false, error: "Missing url" });
      }

      const result = await withBrowser(async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return { title: await page.title() };
      });

      return sendJson(res, 200, { ok: true, url, ...result });
    }

    if (req.method === "POST" && req.url === "/extract") {
      const { url } = await readBody(req);
      if (!url) {
        return sendJson(res, 400, { ok: false, error: "Missing url" });
      }

      const result = await withBrowser(async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const title = await page.title();
        const text = await page.locator("body").innerText();
        return {
          title,
          text: text.slice(0, 12000)
        };
      });

      return sendJson(res, 200, { ok: true, url, ...result });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Playwright API listening on ${PORT}`);
});
