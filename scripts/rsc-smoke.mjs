#!/usr/bin/env node

const appUrl = (process.env.APP_URL ?? "http://127.0.0.1:3300").replace(/\/$/, "");
const apiUrl = (process.env.COMPANION_API_URL ?? "http://127.0.0.1:3301").replace(/\/$/, "");
const email = process.env.BROWSER_SMOKE_EMAIL ?? process.env.COMPANION_SEED_EMAIL ?? "admin@tvc.dev";
const password = process.env.BROWSER_SMOKE_PASSWORD ?? process.env.COMPANION_SEED_PASSWORD ?? "adminadmin";

const cookies = new Map();

function fail(message) {
  console.error(`[rsc-smoke] ${message}`);
  process.exit(1);
}

function setCookiesFrom(response) {
  const headers = response.headers;
  const setCookieHeaders = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const fallback = headers.get("set-cookie");
  const values = setCookieHeaders.length ? setCookieHeaders : fallback ? [fallback] : [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader() {
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function request(path, init = {}) {
  return requestUrl(`${appUrl}${path}`, init);
}

async function apiRequest(path, init = {}) {
  return requestUrl(`${apiUrl}${path}`, init);
}

async function requestUrl(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const cookie = cookieHeader();
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
  });
  setCookiesFrom(response);
  return response;
}

function assertNoDigest(path, body) {
  // A real React production error digest has an alphanumeric value. Next also emits
  // `"digest":"$undefined"` in healthy metadata records, so do not treat the key alone as an error.
  const markers = [/Application error/i, /Server Components render/i, /\\?"digest\\?":\\?"[a-z0-9]/i];
  for (const marker of markers) {
    const match = marker.exec(body);
    if (!match) continue;
    const start = Math.max(0, match.index - 160);
    const context = body.slice(start, match.index + match[0].length + 240).replace(/\s+/g, " ");
    fail(`${path} rendered a production server-component error marker: ${marker}; context: ${context}`);
  }
}

function assertContains(path, body, expected) {
  for (const text of expected) {
    if (!body.includes(text)) {
      fail(`${path} did not contain expected text: ${text}`);
    }
  }
}

async function checkUnauthenticatedRedirect() {
  const saved = new Map(cookies);
  cookies.clear();

  const response = await request("/skills");
  if (response.status < 300 || response.status >= 400) {
    fail(`/skills without session expected redirect, got ${response.status}`);
  }
  const location = response.headers.get("location") ?? "";
  if (!location.includes("/login")) {
    fail(`/skills without session redirected to ${location || "(missing location)"}, expected /login`);
  }

  cookies.clear();
  for (const [name, value] of saved) cookies.set(name, value);
}

async function login() {
  const response = await request("/v1/auth/signin", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: appUrl,
    },
    body: JSON.stringify({ email, password, next: "/skills" }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status !== 200 || data?.ok !== true) {
    fail(`login returned ${response.status}; body: ${JSON.stringify(data).slice(0, 400)}`);
  }
  if (!cookieHeader()) {
    fail("login did not return any auth cookies");
  }
}

async function markCompanionSkillInstalled() {
  const current = await apiRequest("/v1/local-skills/companion");
  const row = await current.json().catch(() => ({}));
  if (!current.ok) {
    fail(`GET /v1/local-skills/companion returned ${current.status}; body: ${JSON.stringify(row).slice(0, 400)}`);
  }
  if (!row.availableVersion) {
    fail("GET /v1/local-skills/companion did not include availableVersion");
  }

  const installed = await apiRequest("/v1/local-skills/companion/installed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: row.availableVersion, agent: "rsc-smoke" }),
  });
  const result = await installed.json().catch(() => ({}));
  if (!installed.ok || result?.ok !== true) {
    fail(
      `POST /v1/local-skills/companion/installed returned ${installed.status}; body: ${JSON.stringify(result).slice(0, 400)}`,
    );
  }
}

async function checkPage(path, expected) {
  const response = await request(path);
  if (response.status >= 500) {
    const text = await response.text().catch(() => "");
    fail(`${path} returned ${response.status}; body: ${text.slice(0, 400)}`);
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    fail(`${path} redirected unexpectedly to ${location || "(missing location)"}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(`${path} returned ${response.status}; body: ${text.slice(0, 400)}`);
  }
  const body = await response.text();
  assertNoDigest(path, body);
  assertContains(path, body, expected);
}

await checkUnauthenticatedRedirect();
await login();
await markCompanionSkillInstalled();
await checkPage("/skills", ["Skills", "Add skill"]);
await checkPage("/settings", ["Settings", "Members"]);

console.log("[rsc-smoke] OK");
