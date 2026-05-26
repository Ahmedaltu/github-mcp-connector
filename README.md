# GitHub MCP Connector for Claude.ai

Connect your GitHub account to Claude.ai. Browse repos, issues, PRs and your profile directly in conversation.

## Tools available in Claude

| Tool | What it does |
|---|---|
| `get_profile` | Your GitHub profile + recent activity |
| `list_repos` | Your repos sorted by last updated |
| `get_repo` | Stats + recent commits for any repo |
| `list_prs` | Open/closed PRs for a repo |
| `list_issues` | Open/closed issues for a repo |

---

## Setup

### 1. Create a GitHub OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in:
   - **Application name**: GitHub MCP for Claude
   - **Homepage URL**: your Railway URL (or `http://localhost:3000` for dev)
   - **Authorization callback URL**: `https://your-app.up.railway.app/oauth/callback`
3. Copy the **Client ID** and generate a **Client Secret**

### 2. Deploy to Railway

```bash
# Clone and push to GitHub first, then:
railway login
railway init
railway up
```

Set environment variables in Railway dashboard:
```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
BASE_URL=https://your-app.up.railway.app
```

### 3. Connect in Claude.ai

1. Go to **Claude.ai → Settings → Integrations**
2. Click **Add MCP server**
3. Enter your Railway URL: `https://your-app.up.railway.app/mcp`
4. Click **Connect** — GitHub OAuth flow opens
5. Authorize → done ✅

### 4. Local development

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```

Server runs at `http://localhost:3000`

---

## Example prompts in Claude

- *"Show me my GitHub repos"*
- *"What are the open issues in my listifyapp repo?"*
- *"Show recent commits on Ahmedaltu/thinbox"*
- *"Any open PRs on my ubuntu-cloud-lab?"*

---

## Publishing to Anthropic's MCP directory

Once deployed and working:
1. Fork `anthropics/anthropic-quickstarts`
2. Add your connector entry with name, URL, description, and tool list
3. Open a PR — Anthropic reviews and lists it

## License

MIT
