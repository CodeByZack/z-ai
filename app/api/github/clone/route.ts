import { NextResponse } from "next/server";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getGitHubToken } from "@/lib/github-auth";
import { parseRepo } from "@/lib/parse-repo";
import { getAgentDir } from "@/lib/session-reader";

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

      const doClone = async (): Promise<void> => {
        // Try gh CLI first
        try {
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

          return;
        } catch {
          // Fallback to git clone
        }

        // Fallback: git clone with GIT_ASKPASS to avoid token in URL
        encode({ type: "progress", message: "gh not available, falling back to git clone..." });

        // Create askpass script that outputs the token
        const askpassPath = join(reposDir, ".git-askpass.sh");
        writeFileSync(askpassPath, `#!/bin/sh\necho "${token}"\n`, "utf-8");
        chmodSync(askpassPath, 0o755);

        const child = spawn("git", ["clone", `https://github.com/${repo}.git`, cloneDir], {
          env: {
            ...process.env,
            GIT_ASKPASS: askpassPath,
            GIT_TERMINAL_PROMPT: "0",
          },
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
        }).finally(() => {
          try { unlinkSync(askpassPath); } catch { /* ignore */ }
        });
      };

      try {
        await doClone();

        // Set git identity for commits — use spawnSync so it completes before we respond
        try {
          spawnSync("git", ["config", "user.name", "z-ai"], { cwd: cloneDir });
          spawnSync("git", ["config", "user.email", "z-ai@local"], { cwd: cloneDir });
        } catch { /* non-critical */ }

        encode({ type: "done", path: cloneDir, message: `Cloned ${repo} to ${cloneDir}` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Clone failed";
        encode({ type: "error", message: msg });
      }

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
