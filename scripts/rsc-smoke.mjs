#!/usr/bin/env node

const appUrl = (process.env.APP_URL ?? "http://127.0.0.1:3300").replace(/\/$/, "");
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
  const headers = new Headers(init.headers ?? {});
  const cookie = cookieHeader();
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${appUrl}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
  setCookiesFrom(response);
  return response;
}

function assertNoDigest(path, body) {
  const markers = [/Application error/i, /Server Components render/i, /\bdigest\b/i];
  for (const marker of markers) {
    if (marker.test(body)) {
      fail(`${path} rendered a production server-component error marker: ${marker}`);
    }
  }
}

function assertContains(path, body, expected) {
  for (const text of expected) {
    if (!body.includes(text)) {
      fail(`${path} did not contain expected text: ${text}`);
    }
  }
}

async function login() {
  const body = new URLSearchParams({
    mode: "signin",
    next: "/skills",
    email,
    password,
  });
  const response = await request("/v1/auth/login-redirect", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: appUrl,
    },
    body,
  });
  if (response.status !== 303) {
    const text = await response.text().catch(() => "");
    fail(`login returned ${response.status}; body: ${text.slice(0, 400)}`);
  }
  if (!cookieHeader()) {
    fail("login did not return any auth cookies");
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

await login();
await checkPage("/skills", ["Skills", "Upload skill"]);
await checkPage("/settings", ["Settings", "Members"]);

console.log("[rsc-smoke] OK");
