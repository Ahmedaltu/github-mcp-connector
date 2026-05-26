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
app.use(express.urlencoded({ extended: true }));

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  BASE_URL = "http://localhost:3000",
  PORT = 3000,
} = process.env;

const MCP_URL = `${BASE_URL}/mcp`;

// ── Token store ──────────────────────────────
const tokenStore = new Map();
const oauthStates = new Map();
const clients = new Map(); // DCR clients

// ── OAuth Protected Resource metadata (RFC 9728) ─
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: MCP_URL,
    authorization_servers: [BASE_URL],
  });
});

// ── OAuth Authorization Server metadata ─────
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  });
});

// ── Dynamic Client Registration ──────────────
app.post("/oauth/register", (req, res) => {
  const clientId = randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  const client = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: req.body.redirect_uris || [],
    ...req.body,
  };
  clients.set(clientId, client);
  res.status(201).json(client);
});

// ── OAuth authorize ──────────────────────────
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state: clientState, code_challenge, code_challenge_method } = req.query;
  const internalState = randomBytes(16).toString("hex");

  oauthStates.set(internalState, { clientState, redirectUri: redirect_uri, codeChallenge: code_challenge });

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/oauth/callback`,
    scope: "read:user repo",
    state: internalState,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GitHub callback ──────────────────────────
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

  const authCode = randomBytes(16).toString("hex");
  tokenStore.set(authCode, { accessToken: access_token, type: "code" });
  oauthStates.delete(state);

  const redirectUrl = new URL(stored.redirectUri);
  redirectUrl.searchParams.set("code", authCode);
  if (stored.clientState) redirectUrl.searchParams.set("state", stored.clientState);

  res.redirect(redirectUrl.toString());
});

// ── Token endpoint — supports client_secret_basic + client_secret_post ──
app.post("/oauth/token", (req, res) => {
  // Support both Basic auth and POST body client credentials
  let clientId, clientSecret;
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    [clientId, clientSecret] = decoded.split(":");
  } else {
    clientId = req.body.client_id;
    clientSecret = req.body.client_secret;
  }

  const { code, grant_type } = req.body;
  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const stored = tokenStore.get(code);
  if (!stored || stored.type !== "code") {
    return res.status(400).json({ error: "invalid_grant" });
  }

  const accessToken = randomBytes(32).toString("hex");
  tokenStore.set(accessToken, { accessToken: stored.accessToken, type: "bearer" });
  tokenStore.delete(code);

  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
  });
});

// ── MCP endpoint — returns 401 with WWW-Authenticate if not authed ──
app.post("/mcp", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.replace("Bearer ", "").trim();
  const session = tokenStore.get(bearerToken);

  // If no valid token, return 401 with resource metadata pointer
  if (!session || session.type !== "bearer") {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: "unauthorized" });
  }

  const octokit = new Octokit({ auth: session.accessToken });

  const server = new McpServer({ name: "GitConnect for Claude", version: "1.0.0" });

  server.tool("get_profile", "Get your GitHub profile and recent activity", {}, async () => {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    return { content: [{ type: "text", text: JSON.stringify({ login: user.login, name: user.name, bio: user.bio, public_repos: user.public_repos, followers: user.followers, following: user.following, url: user.html_url }, null, 2) }] };
  });

  server.tool("list_repos", "List your GitHub repositories sorted by last updated", { limit: z.number().optional() }, async ({ limit = 10 }) => {
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({ sort: "updated", per_page: limit, type: "owner" });
    return { content: [{ type: "text", text: JSON.stringify(data.map(r => ({ name: r.name, description: r.description, language: r.language, stars: r.stargazers_count, updated: r.updated_at, url: r.html_url, private: r.private })), null, 2) }] };
  });

  server.tool("get_repo", "Get overview of a repo including recent commits", { repo: z.string(), owner: z.string().optional() }, async ({ repo, owner }) => {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const o = owner || user.login;
    const [{ data: r }, { data: commits }] = await Promise.all([
      octokit.rest.repos.get({ owner: o, repo }),
      octokit.rest.repos.listCommits({ owner: o, repo, per_page: 5 }),
    ]);
    return { content: [{ type: "text", text: JSON.stringify({ name: r.name, description: r.description, language: r.language, stars: r.stargazers_count, open_issues: r.open_issues_count, recent_commits: commits.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0], author: c.commit.author.name, date: c.commit.author.date })) }, null, 2) }] };
  });

  server.tool("list_prs", "List pull requests for a repository", { repo: z.string(), owner: z.string().optional(), state: z.enum(["open", "closed", "all"]).optional(), limit: z.number().optional() }, async ({ repo, owner, state = "open", limit = 10 }) => {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data } = await octokit.rest.pulls.list({ owner: owner || user.login, repo, state, per_page: limit });
    return { content: [{ type: "text", text: JSON.stringify(data.map(p => ({ number: p.number, title: p.title, author: p.user.login, state: p.state, created: p.created_at, url: p.html_url })), null, 2) }] };
  });

  server.tool("list_issues", "List issues for a repository", { repo: z.string(), owner: z.string().optional(), state: z.enum(["open", "closed", "all"]).optional(), limit: z.number().optional() }, async ({ repo, owner, state = "open", limit = 10 }) => {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data } = await octokit.rest.issues.listForRepo({ owner: owner || user.login, repo, state, per_page: limit });
    return { content: [{ type: "text", text: JSON.stringify(data.filter(i => !i.pull_request).map(i => ({ number: i.number, title: i.title, author: i.user.login, labels: i.labels.map(l => l.name), created: i.created_at, url: i.html_url })), null, 2) }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (req, res) => {
  res.set("WWW-Authenticate", `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: "Use POST with Bearer token" });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`GitConnect MCP running on port ${PORT}`));