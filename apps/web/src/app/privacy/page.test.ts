// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPage from "./page";

// SAFETY: React's test harness reads this documented global flag; the test owns its boolean value.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function renderPrivacy(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(PrivacyPage));
  });
  return container;
}

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("public privacy page", () => {
  it("renders each approved Gmail disclosure verbatim and links back to Companion", async () => {
    const container = await renderPrivacy();
    const paragraphs = Array.from(container.querySelectorAll(".v10-privacy__section p"));
    const disclosures = [
      "When you connect the Gmail integration, Companion requests exactly two OAuth scopes and no others: gmail.readonly (read your mailbox) and gmail.compose (create drafts). No Gmail send, delete or modify permission is ever requested, and no other Google service is accessed.",
      "These permissions are used solely to let your AI assistant, at your direction: search and read email threads to answer questions and summarize conversations; and create drafts in your own mailbox for you to review and send yourself. Companion never sends email on your behalf — drafts are created in your own Gmail mailbox and you send them yourself.",
      "Your Gmail data is accessed directly from Google's Gmail API through Google's hosted Gmail endpoint. It is never sold, rented, shared, transferred, or disclosed to any third party other than Google. It is never used to train machine learning models, never used for advertising, and never combined with other data. The only copy of Gmail content that exists outside Google is inside your private Companion conversation transcript, which is visible only to you and workspace members you explicitly invite, and is never shared.",
      "Your OAuth access and refresh tokens are stored encrypted at rest using envelope encryption, are never returned by any API, and are never logged. All data access is scoped by organization with forced row-level security and least-privilege database roles. All transport uses TLS. You can revoke access at any time by disconnecting the Gmail integration in Companion settings or via your Google Account permissions page — revocation deletes stored credentials immediately.",
      "OAuth credentials are retained only while the Gmail integration remains connected. Disconnecting the integration — or revoking access from your Google Account permissions page — deletes stored credentials from our systems immediately and permanently. Gmail content referenced in a conversation transcript is retained only as long as your Companion conversation exists, and is permanently deleted when you delete the companion or the conversation. Deleting your account deletes all associated data, including stored credentials and transcripts.",
    ];

    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual(
      expect.arrayContaining(disclosures),
    );
    expect(disclosures).toHaveLength(5);
    expect(container.querySelector("h1")?.textContent).toBe("Privacy Policy");
    expect(container.querySelectorAll("h2").length).toBeGreaterThanOrEqual(6);
    expect(container.querySelector("a[href='#privacy-content']")?.textContent).toBe("Skip to content");
    expect(
      Array.from(container.querySelectorAll("a[href='/']")).some(
        (link) => link.textContent?.trim() === "Back to Companion",
      ),
    ).toBe(true);
  });
});
