# Nami Bakes — MCP server

LLM-agnostic. Any MCP client can use it — Claude Desktop, Claude Code,
ChatGPT (via MCP), other LLM apps, or a script over HTTP. It is **not**
tied to Muse.

## Endpoint

Local: `http://localhost:3000/mcp`
Deployed: `https://YOUR-BACKEND-URL/mcp`

Protocol: MCP Streamable HTTP (`POST /mcp`, JSON-RPC). The server uses the
official `@modelcontextprotocol/sdk` (see `server.js`, `createMcpServer()`).

## Auth

If `NAMI_API_KEY` is set on the server, send it as a header on every MCP
request: `x-api-key: <your key>`. If it is not set, no auth is required
(local testing only — set a key before putting it on the internet).

## Connect an MCP client

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "nami-bakes": {
      "url": "http://localhost:3000/mcp",
      "headers": { "x-api-key": "YOUR_KEY_IF_SET" }
    }
  }
}
```
Restart Claude Desktop after editing the config. For a deployed server,
replace the URL with `https://YOUR-BACKEND-URL/mcp`.

### Other LLM clients
Any client that supports MCP Streamable HTTP / remote MCP servers: add a
server with the URL above. Clients that only support local (stdio) MCP
servers can run the server locally with `npm start` and point at the
same URL, or use an MCP proxy — the protocol is standard, there is
nothing Muse-specific in it.

### Raw HTTP test (no client needed)
```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# then tools/list, then tools/call — see test/verify.js for a full example
```

## Tools

| Tool | What it does |
|---|---|
| `list_inventory` | All ingredients, current/min stock |
| `get_ingredient` | One ingredient by id or name |
| `adjust_inventory` | Set current and/or min for an ingredient |
| `add_ingredient` | Add a new ingredient |
| `list_recipes` | All recipes, per-portion ingredients |
| `get_recipe` | One recipe by id or name |
| `create_recipe` | Create a recipe (per-portion ingredients) |
| `plan_bake` | Plan items, get aggregated sub-recipes. `items: [{recipeId, qty}]` |
| `get_bake_plan` | Get a saved bake plan + its calculation |
| `complete_bake` | Complete a plan — deducts stock |
| `get_shopping_list` | Friday shopping list (below-min + planned bakes) |
| `get_restock_forecast` | Alias for `get_shopping_list` |
| `make_cookie_dough` | Make dough: 1 batch = 12 balls. `batchesMade` (usually 1), `cookiesBakedNow` (0–12 per batch); the rest are frozen as balls. Legacy `portionsMade` / `portionsBakedNow` / `portionsFrozen` (in batches) also accepted. |

All tools use the same calculation code as the web UI (`lib/calc.js`),
including sub-recipe aggregation and the brownie egg rule:
aggregate brownie portions first, then 3 eggs per whole portion +
2 eggs for a 0.5 remainder (0.5→2, 1.0→3, 1.5→5, 2.0→6, 2.5→8).
