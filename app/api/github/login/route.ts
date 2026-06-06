import { NextResponse } from "next/server";
import { getGitHubConfig, isGitHubConfigured } from "@/lib/github-auth";

// GET /api/github/login — redirect to GitHub OAuth page
export async function GET(req: Request) {
  if (!isGitHubConfigured()) {
    return NextResponse.json(
      { error: "GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." },
      { status: 400 }
    );
  }

  const config = getGitHubConfig();

  // Derive redirect URI from the request origin (works for both localhost and NAS)
  const { origin } = new URL(req.url);
  const redirectUri = config.redirectUri || `${origin}/api/github/callback`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: "repo,read:user",
    response_type: "code",
  });

  const url = `https://github.com/login/oauth/authorize?${params.toString()}`;
  return NextResponse.redirect(url);
}
