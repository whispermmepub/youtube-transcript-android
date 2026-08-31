import { describe, expect, it } from "vitest";

describe("GitHub API credential", () => {
  it("can read the authenticated user without exposing the token", async () => {
    const token = process.env.GITHUB_REPO_TOKEN;
    expect(token, "GITHUB_REPO_TOKEN must be configured for this validation").toBeTruthy();

    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "youtube-transcript-android",
      },
    });

    expect(response.ok).toBe(true);
    const user = (await response.json()) as { login?: string };
    expect(user.login).toBeTruthy();
  }, 20_000);
});
