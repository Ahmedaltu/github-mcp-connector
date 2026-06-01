# GitConnect for Claude

A GitHub MCP connector for Claude.ai — browse repos, issues, PRs, create repos, fork projects, and more, all conversationally.

Built with Node.js, Express, and the official MCP SDK. Deployed on Railway with GitHub OAuth 2.1.

---

## What you can ask Claude

- *"Show me my GitHub repos"*
- *"What are the open issues on my thinbox repo?"*
- *"Any open PRs on github-mcp-connector?"*
- *"Show recent commits on cloudinit-aigen"*
- *"Create a new private repo called my-project"*
- *"Fork anthropics/anthropic-quickstarts for me"*

---

## Tools

| Tool | Description |
|---|---|
| `get_profile` | Your GitHub profile and recent activity |
| `list_repos` | Your repos sorted by last updated |
| `get_repo` | Stats and recent commits for any repo |
| `list_prs` | Open/closed PRs for a repo |
| `list_issues` | Open/closed issues for a repo |
| `create_repo` | Create a new GitHub repository |
| `fork_repo` | Fork any GitHub repository |

---

## Connect to Claude.ai (use hosted version)

1. Go to **Claude.ai → Customize → Connectors → +**
2. Fill in:
   - **Name**: `GitConnect for Claude`
   - **Remote MCP server URL**: `https://github-mcp-connector-production.up.railway.app/mcp`
   - **OAuth Client ID**: your GitHub OAuth app Client ID
   - **OAuth Client Secret**: your GitHub OAuth app Client Secret
3. Click **Add** then **Connect**
4. Authorize with your GitHub account
5. Done ✅

---

## Self-host

### 1. Create a GitHub OAuth App

Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**

- **Application name**: `GitConnect for Claude`
- **Homepage URL**: `https://your-app.up.railway.app`
- **Authorization callback URL**: `https://your-app.up.railway.app/oauth/callback`

Copy the **Client ID** and generate a **Client Secret**.

### 2. Deploy to Railway

```bash
git clone https://github.com/Ahmedaltu/github-mcp-connector
cd github-mcp-connector
railway login
railway init
railway up
```

Set environment variables in Railway dashboard:

```
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
BASE_URL=https://your-app.up.railway.app
```

### 3. Connect in Claude.ai

Follow the same steps above using your own Railway URL.

---

## Stack

- **Runtime**: Node.js + Express
- **Protocol**: MCP SDK (Streamable HTTP transport)
- **Auth**: OAuth 2.1 with PKCE
- **Deployment**: Railway

---

## License

MIT