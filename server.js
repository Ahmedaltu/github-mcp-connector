import express from "express";
import cors from "cors";
import { Octokit } from "@octokit/rest";
import { randomBytes } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory token store (replace with Redis/DB for production) ──
const tokenStore = new Map(); // sessionId -> { accessToken, login }
const oauthStates = new Map(); // state -> sessionId

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  BASE_URL = "http://localhost:3000",
  PORT = 3000,
} = process.env;

// ─────────────────────────────────────────────
//  OAuth flow
// ─────────────────────────────────────────────

// 1. Claude calls this to start OAuth
app.get("/oauth/authorize", (req, res) => {
  const sessionId = randomBytes(16).toString("hex");
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, sessionId);

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/oauth/callback`,
    scope: "read:user repo",
    state,
  });

  // Return session info + redirect URL to Claude
  res.json({
    sessionId,
    authUrl: `https://github.com/login/oauth/authorize?${params}`,
  });
});

// 2. GitHub redirects here after user approves
app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const sessionId = oauthStates.get(state);
  if (!sessionId) return res.status(400).send("Invalid state");

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}/oauth/callback`,
    }),
  });

  const { access_token, error } = await tokenRes.json();
  if (error || !access_token) return res.status(400).send("OAuth failed");

  const octokit = new Octokit({ auth: access_token });
  const { data: user } = await octokit.rest.users.getAuthenticated();

  tokenStore.set(sessionId, { accessToken: access_token, login: user.login });
  oauthStates.delete(state);

  // Close the popup / show success
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ Connected as <strong>${user.login}</strong></h2>
      <p>You can close this tab and return to Claude.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>
  `);
});

// ─────────────────────────────────────────────
//  MCP endpoint — all tool calls come here
// ─────────────────────────────────────────────

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  const session = tokenStore.get(sessionId);

  if (!session) {
    return res.status(401).json({
      error: "Not authenticated. Start OAuth at /oauth/authorize",
    });
  }

  const octokit = new Octokit({ auth: session.accessToken });
  const { tool, params = {} } = req.body;

  try {
    switch (tool) {
      // ── List repos ──────────────────────────
      case "list_repos": {
        const { data } = await octokit.rest.repos.listForAuthenticatedUser({
          sort: "updated",
          per_page: params.limit || 10,
          type: "owner",
        });
        return res.json(
          data.map((r) => ({
            name: r.name,
            description: r.description,
            language: r.language,
            stars: r.stargazers_count,
            forks: r.forks_count,
            updated: r.updated_at,
            url: r.html_url,
            private: r.private,
          }))
        );
      }

      // ── Repo overview ────────────────────────
      case "get_repo": {
        const { repo } = params;
        const owner = params.owner || session.login;
        const [{ data: r }, { data: commits }] = await Promise.all([
          octokit.rest.repos.get({ owner, repo }),
          octokit.rest.repos.listCommits({ owner, repo, per_page: 5 }),
        ]);
        return res.json({
          name: r.name,
          description: r.description,
          language: r.language,
          stars: r.stargazers_count,
          forks: r.forks_count,
          open_issues: r.open_issues_count,
          default_branch: r.default_branch,
          url: r.html_url,
          recent_commits: commits.map((c) => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0],
            author: c.commit.author.name,
            date: c.commit.author.date,
          })),
        });
      }

      // ── Open PRs ─────────────────────────────
      case "list_prs": {
        const { repo } = params;
        const owner = params.owner || session.login;
        const { data } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: params.state || "open",
          per_page: params.limit || 10,
        });
        return res.json(
          data.map((p) => ({
            number: p.number,
            title: p.title,
            author: p.user.login,
            state: p.state,
            created: p.created_at,
            url: p.html_url,
            draft: p.draft,
          }))
        );
      }

      // ── Open issues ──────────────────────────
      case "list_issues": {
        const { repo } = params;
        const owner = params.owner || session.login;
        const { data } = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: params.state || "open",
          per_page: params.limit || 10,
        });
        return res.json(
          data
            .filter((i) => !i.pull_request) // exclude PRs
            .map((i) => ({
              number: i.number,
              title: i.title,
              author: i.user.login,
              labels: i.labels.map((l) => l.name),
              created: i.created_at,
              url: i.html_url,
            }))
        );
      }

      // ── User profile ─────────────────────────
      case "get_profile": {
        const { data: user } = await octokit.rest.users.getAuthenticated();
        const { data: events } = await octokit.rest.activity.listEventsForAuthenticatedUser({
          username: user.login,
          per_page: 10,
        });
        return res.json({
          login: user.login,
          name: user.name,
          bio: user.bio,
          public_repos: user.public_repos,
          followers: user.followers,
          following: user.following,
          avatar: user.avatar_url,
          url: user.html_url,
          recent_events: events.slice(0, 5).map((e) => ({
            type: e.type,
            repo: e.repo.name,
            date: e.created_at,
          })),
        });
      }

      default:
        return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  MCP manifest — Claude reads this to discover tools
// ─────────────────────────────────────────────

app.get("/mcp", (req, res) => {
  res.json({
    name: "GitHub Connector",
    description: "Browse your GitHub repos, issues, PRs and profile from Claude",
    version: "1.0.0",
    auth: {
      type: "oauth2",
      authorizeUrl: `${BASE_URL}/oauth/authorize`,
    },
    tools: [
      {
        name: "get_profile",
        description: "Get the authenticated user's GitHub profile and recent activity",
        parameters: {},
      },
      {
        name: "list_repos",
        description: "List your GitHub repositories sorted by last updated",
        parameters: {
          limit: { type: "number", description: "Max repos to return (default 10)" },
        },
      },
      {
        name: "get_repo",
        description: "Get overview of a specific repo: stats, recent commits",
        parameters: {
          repo: { type: "string", required: true, description: "Repository name" },
          owner: { type: "string", description: "Owner login (defaults to you)" },
        },
      },
      {
        name: "list_prs",
        description: "List pull requests for a repository",
        parameters: {
          repo: { type: "string", required: true },
          owner: { type: "string" },
          state: { type: "string", description: "open | closed | all (default: open)" },
          limit: { type: "number" },
        },
      },
      {
        name: "list_issues",
        description: "List issues for a repository (excludes PRs)",
        parameters: {
          repo: { type: "string", required: true },
          owner: { type: "string" },
          state: { type: "string", description: "open | closed | all (default: open)" },
          limit: { type: "number" },
        },
      },
    ],
  });
});

app.listen(PORT, () => console.log(`GitHub MCP server running on port ${PORT}`));
