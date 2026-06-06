import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getGitHubToken } from "@/lib/github-auth";
import { getAgentDir } from "@/lib/session-reader";

// Extract owner/repo from either "owner/repo" or full URL
function parseRepo(input: string): string | null {
  const trimmed = input.trim();

  // Already owner/repo format
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) return trimmed;

  // Full URL: https://github.com/owner/repo.git or https://github.com/owner/repo
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") {
      const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    // not a valid URL
  }

  return null;
}

// POST /api/github/clone — clone a repo, stream progress via SSE
// Accepts: "owner/repo" or "https://github.com/owner/repo[.git]"
// Repos are stored under ~/.pi/agent/repos/ for easy Docker volume mapping
export async function POST(req: Request) {
  const token = getGitHubToken();
  if (!token) {
    return NextResponse.json({ error: "Not logged in to GitHub" }, { status: 401 });
  }

  const body = (await req.json()) as { repo?: string };
  const repoInput = body.repo?.trim();

  if (!repoInput) {
    return NextResponse.json({ error: "repo is required (e.g. owner/repo or full URL)" }, { status: 400 });
  }

  const repo = parseRepo(repoInput);
  if (!repo) {
    return NextResponse.json({ error: "Invalid repo. Use owner/repo or https://github.com/owner/repo" }, { status: 400 });
  }

  const agentDir = getAgentDir();
  const reposDir = join(agentDir, "repos");
  if (!existsSync(reposDir)) mkdirSync(reposDir, { recursive: true });

  const cloneDir = join(reposDir, repo.replace("/", "-"));

  const stream = new ReadableStream({
    async start(controller) {
      const encode = (data: unknown) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Check if already cloned
      if (existsSync(cloneDir)) {
        encode({ type: "done", path: cloneDir, message: `Repo already exists at ${cloneDir}` });
        controller.close();
        return;
      }

      encode({ type: "progress", message: `Cloning ${repo}...` });

      try {
        // Try gh CLI first, fall back to git clone
        const child = spawn("gh", ["repo", "clone", repo, cloneDir], {
          env: { ...process.env, GH_TOKEN: token },
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.on("data", (data: Buffer) => {
          const lines = data.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            encode({ type: "progress", message: line });
          }
        });

        child.stderr.on("data", (data: Buffer) => {
          const lines = data.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            // gh outputs progress on stderr — treat as progress, not error
            encode({ type: "progress", message: line });
          }
        });

        await new Promise<void>((resolve, reject) => {
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`gh repo clone exited with code ${code}`));
          });
          child.on("error", reject);
        });
      } catch {
        // Fallback: git clone with token in URL
        encode({ type: "progress", message: "gh not available, falling back to git clone..." });
        const gitUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

        const child = spawn("git", ["clone", gitUrl, cloneDir], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stderr.on("data", (data: Buffer) => {
          const lines = data.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            encode({ type: "progress", message: line });
          }
        });

        await new Promise<void>((resolve, reject) => {
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`git clone exited with code ${code}`));
          });
          child.on("error", reject);
        });
      }

      // Set git identity for commits
      try {
        spawn("git", ["config", "user.name", "z-ai"], { cwd: cloneDir });
        spawn("git", ["config", "user.email", "z-ai@local"], { cwd: cloneDir });
      } catch { /* non-critical */ }

      encode({ type: "done", path: cloneDir, message: `Cloned ${repo} to ${cloneDir}` });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
