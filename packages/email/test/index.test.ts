import { describe, expect, it } from "vitest";
import { escapeHtml, inviteEmail } from "../src/index";

describe("transactional email templates", () => {
  it("escapes user-controlled organization names in invite HTML", () => {
    const email = inviteEmail({
      to: "dev@example.com",
      orgName: "Acme <script>alert(1)</script>",
      inviteUrl: "http://127.0.0.1:3000/join/token",
    });

    expect(email.html).toContain("Acme &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(email.html).not.toContain("<script>");
  });

  it("escapes HTML special characters", () => {
    expect(escapeHtml(`A&B<>"'`)).toBe("A&amp;B&lt;&gt;&quot;&#39;");
  });
});
