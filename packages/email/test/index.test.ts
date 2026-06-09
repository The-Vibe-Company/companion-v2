import { describe, expect, it } from "vitest";
import { escapeHtml, inviteEmail, passwordResetCodeEmail, verificationCodeEmail } from "../src/index";

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

  it("renders the verification code with a stable idempotency key", () => {
    const email = verificationCodeEmail({ to: "dev@example.com", code: "284917" });

    expect(email.subject).toBe("Your Companion verification code");
    expect(email.html).toContain("284917");
    expect(email.text).toContain("284917");
    expect(email.idempotencyKey).toBe("verify:dev@example.com:284917");
  });

  it("renders the password reset code with a distinct subject and key", () => {
    const email = passwordResetCodeEmail({ to: "dev@example.com", code: "100200" });

    expect(email.subject).toBe("Reset your Companion password");
    expect(email.html).toContain("100200");
    expect(email.idempotencyKey).toBe("reset:dev@example.com:100200");
  });

  it("escapes a non-numeric code defensively", () => {
    const email = verificationCodeEmail({ to: "dev@example.com", code: "<b>x" });

    expect(email.html).toContain("&lt;b&gt;x");
    expect(email.html).not.toContain("<b>x");
  });
});
