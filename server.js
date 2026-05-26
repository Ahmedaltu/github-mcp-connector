import express from "express";
import cors from "cors";
import { Octokit } from "@octokit/rest";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["mcp-session-id"] }));
app.use(express.json());

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  BASE_URL = "http://localhost:3000",
  PORT = 3000,
} = process.env;

// ── Token store ──────────────────────────────
const tokenStore = new Map(); // sessionId -> accessToken
const oauthStates = new Map(); // state -> sessionId

// ── OAuth flow ───────────────────────────────
app.get("/oauth/authorize", (req, res) => {
  const sessionId = req.query.sessionId || randomBytes(16).toString("hex");
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, sessionId);

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/oauth/callback`,
    scope: "read:user repo",
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const sessionId = oauthStates.get(state);
  if (!sessionId) return res.status(400).send("Invalid state");

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

  tokenStore.set(sessionId, access_token);
  oauthStates.delete(state);

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1117;color:#fff">
      <h2>✅ Connected to GitHub!</h2>
      <p>You can close this tab and return to Claude.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>
  `);
});

// ── MCP SSE endpoint ─────────────────────────
const transports = new Map();

app.get("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId || randomBytes(16).toString("hex");
  const accessToken = tokenStore.get(sessionId);

  const server = new McpServer({
    name: "GitConnect for Claude",
    version: "1.0.0",
  });

  const octokit = accessToken ? new Octokit({ auth: accessToken }) : null;

  // Tool: get_profile
  server.tool("get_profile", "Get your GitHub profile and recent activity", {}, async () => {
    if (!octokit) return { content: [{ type: "text", text: `Not authenticated. Please visit: ${BASE_URL}/oauth/authorize?sessionId=${sessionId}` }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    return {
      content: [{
        type: "text", text: JSON.stringify({
          login: user.login, name: user.name, bio: user.bio,
          public_repos: user.public_repos, followers: user.followers,
          following: user.following, url: user.html_url,
        }, null, 2)
      }]
    };
  });

  // Tool: list_repos
  server.tool("list_repos", "List your GitHub repositories sorted by last updated", {
    limit: z.number().optional().describe("Max repos to return (default 10)"),
  }, async ({ limit = 10 }) => {
    if (!octokit) return { content: [{ type: "text", text: `Not authenticated. Please visit: ${BASE_URL}/oauth/authorize?sessionId=${sessionId}` }] };
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({ sort: "updated", per_page: limit, type: "owner" });
    return {
      content: [{
        type: "text", text: JSON.stringify(data.map(r => ({
          name: r.name, description: r.description, language: r.language,
          stars: r.stargazers_count, updated: r.updated_at, url: r.html_url, private: r.private,
        })), null, 2)
      }]
    };
  });

  // Tool: get_repo
  server.tool("get_repo", "Get overview of a specific repo including recent commits", {
    repo: z.string().describe("Repository name"),
    owner: z.string().optional().describe("Owner login (defaults to you)"),
  }, async ({ repo, owner }) => {
    if (!octokit) return { content: [{ type: "text", text: `Not authenticated. Please visit: ${BASE_URL}/oauth/authorize?sessionId=${sessionId}` }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const o = owner || user.login;
    const [{ data: r }, { data: commits }] = await Promise.all([
      octokit.rest.repos.get({ owner: o, repo }),
      octokit.rest.repos.listCommits({ owner: o, repo, per_page: 5 }),
    ]);
    return {
      content: [{
        type: "text", text: JSON.stringify({
          name: r.name, description: r.description, language: r.language,
          stars: r.stargazers_count, open_issues: r.open_issues_count,
          recent_commits: commits.map(c => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0],
            author: c.commit.author.name,
            date: c.commit.author.date,
          })),
        }, null, 2)
      }]
    };
  });

  // Tool: list_prs
  server.tool("list_prs", "List pull requests for a repository", {
    repo: z.string().describe("Repository name"),
    owner: z.string().optional(),
    state: z.enum(["open", "closed", "all"]).optional().describe("PR state (default: open)"),
    limit: z.number().optional(),
  }, async ({ repo, owner, state = "open", limit = 10 }) => {
    if (!octokit) return { content: [{ type: "text", text: `Not authenticated. Please visit: ${BASE_URL}/oauth/authorize?sessionId=${sessionId}` }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data } = await octokit.rest.pulls.list({ owner: owner || user.login, repo, state, per_page: limit });
    return {
      content: [{
        type: "text", text: JSON.stringify(data.map(p => ({
          number: p.number, title: p.title, author: p.user.login,
          state: p.state, created: p.created_at, url: p.html_url,
        })), null, 2)
      }]
    };
  });

  // Tool: list_issues
  server.tool("list_issues", "List issues for a repository", {
    repo: z.string().describe("Repository name"),
    owner: z.string().optional(),
    state: z.enum(["open", "closed", "all"]).optional().describe("Issue state (default: open)"),
    limit: z.number().optional(),
  }, async ({ repo, owner, state = "open", limit = 10 }) => {
    if (!octokit) return { content: [{ type: "text", text: `Not authenticated. Please visit: ${BASE_URL}/oauth/authorize?sessionId=${sessionId}` }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data } = await octokit.rest.issues.listForRepo({ owner: owner || user.login, repo, state, per_page: limit });
    return {
      content: [{
        type: "text", text: JSON.stringify(
          data.filter(i => !i.pull_request).map(i => ({
            number: i.number, title: i.title, author: i.user.login,
            labels: i.labels.map(l => l.name), created: i.created_at, url: i.html_url,
          })), null, 2)
      }]
    };
  });

  const transport = new SSEServerTransport("/messages", res);
  transports.set(sessionId, transport);
  res.on("close", () => transports.delete(sessionId));
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => console.log(`GitConnect MCP server running on port ${PORT}`));