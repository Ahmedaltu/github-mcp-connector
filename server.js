import express from "express";
import cors from "cors";
import { Octokit } from "@octokit/rest";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  BASE_URL = "http://localhost:3000",
  PORT = 3000,
} = process.env;

// ── Token store ──────────────────────────────
const tokenStore = new Map(); // sessionId -> accessToken
const oauthStates = new Map(); // state -> {sessionId, redirectUri}

// ── OAuth Discovery endpoint (required by MCP auth spec) ────
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ── OAuth authorize ──────────────────────────
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state: clientState, client_id } = req.query;
  const internalState = randomBytes(16).toString("hex");

  oauthStates.set(internalState, {
    clientState,
    redirectUri: redirect_uri,
  });

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/oauth/callback`,
    scope: "read:user repo",
    state: internalState,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GitHub OAuth callback ────────────────────
app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  const stored = oauthStates.get(state);
  if (!stored) return res.status(400).send("Invalid state");

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
  if (error || !access_token) return res.status(400).send("OAuth failed: " + error);

  // Store token with a short-lived auth code
  const authCode = randomBytes(16).toString("hex");
  tokenStore.set(authCode, { accessToken: access_token, type: "code" });
  oauthStates.delete(state);

  const redirectUrl = new URL(stored.redirectUri);
  redirectUrl.searchParams.set("code", authCode);
  if (stored.clientState) redirectUrl.searchParams.set("state", stored.clientState);

  res.redirect(redirectUrl.toString());
});

// ── Token endpoint ───────────────────────────
app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
  const { code, grant_type } = req.body;
  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });

  const stored = tokenStore.get(code);
  if (!stored || stored.type !== "code") return res.status(400).json({ error: "invalid_grant" });

  const accessToken = randomBytes(32).toString("hex");
  tokenStore.set(accessToken, { accessToken: stored.accessToken, type: "bearer" });
  tokenStore.delete(code);

  res.json({ access_token: accessToken, token_type: "bearer" });
});

// ── MCP Streamable HTTP endpoint ─────────────
app.post("/mcp", async (req, res) => {
  // Get bearer token from Authorization header
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.replace("Bearer ", "").trim();
  const session = tokenStore.get(bearerToken);
  const accessToken = session?.accessToken;

  const octokit = accessToken ? new Octokit({ auth: accessToken }) : null;

  const server = new McpServer({
    name: "GitConnect for Claude",
    version: "1.0.0",
  });

  // Tool: get_profile
  server.tool("get_profile", "Get your GitHub profile and recent activity", {}, async () => {
    if (!octokit) return { content: [{ type: "text", text: "Not authenticated with GitHub." }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    return {
      content: [{ type: "text", text: JSON.stringify({
        login: user.login, name: user.name, bio: user.bio,
        public_repos: user.public_repos, followers: user.followers,
        following: user.following, url: user.html_url,
      }, null, 2) }]
    };
  });

  // Tool: list_repos
  server.tool("list_repos", "List your GitHub repositories sorted by last updated", {
    limit: z.number().optional().describe("Max repos to return (default 10)"),
  }, async ({ limit = 10 }) => {
    if (!octokit) return { content: [{ type: "text", text: "Not authenticated with GitHub." }] };
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({ sort: "updated", per_page: limit, type: "owner" });
    return {
      content: [{ type: "text", text: JSON.stringify(data.map(r => ({
        name: r.name, description: r.description, language: r.language,
        stars: r.stargazers_count, updated: r.updated_at, url: r.html_url, private: r.private,
      })), null, 2) }]
    };
  });

  // Tool: get_repo
  server.tool("get_repo", "Get overview of a repo including recent commits", {
    repo: z.string().describe("Repository name"),
    owner: z.string().optional().describe("Owner login (defaults to you)"),
  }, async ({ repo, owner }) => {
    if (!octokit) return { content: [{ type: "text", text: "Not authenticated with GitHub." }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const o = owner || user.login;
    const [{ data: r }, { data: commits }] = await Promise.all([
      octokit.rest.repos.get({ owner: o, repo }),
      octokit.rest.repos.listCommits({ owner: o, repo, per_page: 5 }),
    ]);
    return {
      content: [{ type: "text", text: JSON.stringify({
        name: r.name, description: r.description, language: r.language,
        stars: r.stargazers_count, open_issues: r.open_issues_count,
        recent_commits: commits.map(c => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0],
          author: c.commit.author.name, date: c.commit.author.date,
        })),
      }, null, 2) }]
    };
  });

  // Tool: list_prs
  server.tool("list_prs", "List pull requests for a repository", {
    repo: z.string().describe("Repository name"),
    owner: z.string().optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    limit: z.number().optional(),
  }, async ({ repo, owner, state = "open", limit = 10 }) => {
    if (!octokit) return { content: [{ type: "text", text: "Not authenticated with GitHub." }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data } = await octokit.rest.pulls.list({ owner: owner || user.login, repo, state, per_page: limit });
    return {
      content: [{ type: "text", text: JSON.stringify(data.map(p => ({
        number: p.number, title: p.title, author: p.user.login,
        state: p.state, created: p.created_at, url: p.html_url,
      })), null, 2) }]
    };
  });

  // Tool: list_issues
  server.tool("list_issues", "List issues for a repository", {
    repo: z.string().describe("Repository name"),
    owner: z.string().optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    limit: z.number().optional(),
  }, async ({ repo, owner, state = "open", limit = 10 }) => {
    if (!octokit) return { content: [{ type: "text", text: "Not authenticated with GitHub." }] };
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data } = await octokit.rest.issues.listForRepo({ owner: owner || user.login, repo, state, per_page: limit });
    return {
      content: [{ type: "text", text: JSON.stringify(
        data.filter(i => !i.pull_request).map(i => ({
          number: i.number, title: i.title, author: i.user.login,
          labels: i.labels.map(l => l.name), created: i.created_at, url: i.html_url,
        })), null, 2) }]
    };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Use POST for MCP requests" });
});

app.listen(PORT, () => console.log(`GitConnect MCP server running on port ${PORT}`));