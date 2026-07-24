import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env.COMPANION_SEED_EMAIL ?? "admin@thevibecompany.co";
const PASSWORD = process.env.COMPANION_SEED_PASSWORD ?? "adminadmin";

const browserFailures = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);

  // Gravatar deliberately returns 404 when no avatar exists (`d=404`). It is an external image
  // provider, not part of either product promise, so keep the journey deterministic at that seam.
  await page.route("https://www.gravatar.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      failures.push(`console.error${source ? ` at ${source}` : ""}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) failures.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "unknown failure";
    if (!reason.includes("ERR_ABORTED")) failures.push(`request failed (${reason}): ${request.url()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? [], "the critical flow must not hide browser or server failures").toEqual([]);
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#si-email").fill(EMAIL);
  await page.locator("#si-pw").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/skills(?:\?|$)/);
  // The URL changes before the App Router client has necessarily hydrated. Waiting for the idle
  // boundary prevents a click on server-rendered markup from being accepted visually but lost.
  await page.waitForLoadState("networkidle");
}

/**
 * Product promise:
 * A personal skill stays in My Skills with its private folder until its owner explicitly shares it,
 * then the same skill appears in the organization library.
 *
 * Regression caught:
 * The browser can accidentally publish to the wrong scope, lose the selected personal folder, or
 * leave the UI on a stale personal copy after Share even when the service layer is correct.
 *
 * Why this test needs a browser:
 * Only a real browser covers the create drawer, folder picker, client refresh, Share confirmation,
 * history state, and final library rendering as one user-visible operation.
 *
 * Failure proof:
 * Service-level scope and creator-filter faults are proved by skillLifecycle.integration.test.ts;
 * this flow additionally fails if the UI sends the wrong scope/label or does not render the move.
 */
test("a personal skill moves from its private folder to the organization only after Share", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const slug = `e2e-personal-${suffix}`;
  const folder = `e2e/${suffix}`;

  await signIn(page);
  await page.getByRole("button", { name: "Add skill" }).click();

  const createDialog = page.getByRole("dialog", { name: "Add a personal skill" });
  await createDialog.getByRole("button", { name: /Create in browser/ }).click();
  await createDialog.locator("#up-create-id").fill(slug);
  await createDialog.locator("#up-create-desc").fill("Protect the personal-to-organization browser contract.");
  await createDialog.getByRole("button", { name: "No folders" }).click();
  await createDialog.getByLabel("Search or create a folder").fill(folder);
  await createDialog.getByLabel("Search or create a folder").press("Enter");
  await expect(createDialog.getByRole("button", { name: folder })).toBeVisible();
  await createDialog.getByRole("button", { name: "Create skill", exact: true }).click();

  await expect(createDialog.getByRole("status")).toContainText("Skill published");
  await createDialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "My Skills", exact: true }).click();
  await page.locator('button.lblrow__main[title="e2e"]').click();
  await page.locator(`button.lblrow__main[title="${folder}"]`).click();
  await expect(page.getByRole("button", { name: `Open skill ${slug}` })).toBeVisible();
  await page.getByRole("button", { name: `Open skill ${slug}` }).click();

  await expect(page.getByText("Personal skill", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Share to organization", exact: true }).click();
  const shareDialog = page.getByRole("dialog", { name: "Share to organization?" });
  await expect(shareDialog.getByRole("button", { name: "Share to organization", exact: true })).toBeEnabled();
  await shareDialog.getByRole("button", { name: "Share to organization", exact: true }).click();

  await expect(page.getByText(`Shared ${slug} to`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Organization", exact: true }).click();
  await expect(page.getByRole("button", { name: `Open skill ${slug}` })).toBeVisible();
});

/**
 * Product promise:
 * A secret value is accepted exactly once during creation and is never rendered again; only safe
 * metadata remains visible.
 *
 * Regression caught:
 * A form-state or response-shape regression could keep plaintext in an input, toast, drawer, or
 * browser console after the save succeeds.
 *
 * Why this test needs a browser:
 * Service tests prove storage and response redaction, while the browser is the only level that can
 * prove the actual post-save DOM has discarded the typed value and exposes no reveal/copy action.
 *
 * Failure proof:
 * Plaintext response/storage faults are proved by secretLifecycle.integration.test.ts; this flow
 * fails if the UI retains or re-renders the sentinel after creation.
 */
test("saving a secret discards its value and renders metadata only", async ({ page }) => {
  const suffix = `${Date.now()}`;
  const sentinel = `e2e-plaintext-${suffix}`;
  const key = `E2E_SECRET_${suffix}`;

  await signIn(page);
  await page.goto("/secrets");
  await page.getByRole("button", { name: "New secret" }).click();

  let drawer = page.getByRole("dialog");
  await drawer.getByLabel("Name").fill(`E2E secret ${suffix}`);
  await drawer.getByLabel("Environment key").fill(key);
  await drawer.getByRole("textbox", { name: "Secret value" }).fill(sentinel);
  await drawer.getByLabel("Who can use it").selectOption("personal");
  await drawer.getByRole("button", { name: "Create secret", exact: true }).click();

  drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Value protected", { exact: true })).toBeVisible();
  await expect(drawer.getByText(key, { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /show secret|copy secret/i })).toHaveCount(0);
  await expect.poll(async () => drawer.locator("input").evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(sentinel);
  await expect(page.locator("body")).not.toContainText(sentinel);
});
