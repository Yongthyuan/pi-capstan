import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Example: Custom database query tool for workers
 *
 * This extension adds a `swarm_query_db` tool that allows workers to
 * execute read-only SQL queries against the project database.
 *
 * Install:
 * 1. Copy this file to ~/.pi/agent/extensions/db-tools.ts
 * 2. Add to .pi/swarm.json:
 *    {
 *      "safetyGuardPath": "~/.pi/agent/extensions/db-tools.ts"
 *    }
 * 3. Configure database connection via environment variables
 */

export default function(pi: ExtensionAPI) {
  // Custom tool: Query project database
  pi.registerTool({
    name: "swarm_query_db",
    label: "Query Project Database",
    description: "Execute read-only SQL query against project database to retrieve schema information, sample data, or table relationships",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SELECT query to execute (INSERT/UPDATE/DELETE not allowed)"
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 100)",
          default: 100
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(_id: string, params: { query: string; limit?: number }) {
      try {
        // Validate read-only
        const sql = params.query.trim().toLowerCase();
        if (!sql.startsWith("select") && !sql.startsWith("show") && !sql.startsWith("describe")) {
          return {
            content: [{ type: "text", text: "Only SELECT, SHOW, DESCRIBE queries allowed" }],
            isError: true
          };
        }

        // Example implementation (replace with your actual DB client)
        // const db = await connectToDatabase();
        // const results = await db.query(params.query, { maxRows: params.limit ?? 100 });

        // Placeholder response
        const results = [
          { table: "users", columns: "id, email, created_at" },
          { table: "posts", columns: "id, user_id, title, content" }
        ];

        return {
          content: [{
            type: "text",
            text: `Query results:\n${JSON.stringify(results, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Database query failed: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }
  } as any);

  // Custom tool: Semantic code search
  pi.registerTool({
    name: "swarm_semantic_search",
    label: "Semantic Code Search",
    description: "Search codebase using natural language to find relevant code patterns, implementations, or examples",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of what to find"
        },
        maxResults: {
          type: "number",
          description: "Max results to return (default 5)",
          default: 5
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(_id: string, params: { query: string; maxResults?: number }) {
      try {
        // Example implementation (replace with your actual semantic search)
        // const embeddings = await getEmbeddings(params.query);
        // const matches = await vectorSearch(embeddings, params.maxResults ?? 5);

        // Placeholder response
        const matches = [
          {
            file: "src/auth/oauth.ts",
            line: 42,
            snippet: "async function handleOAuthCallback(...)",
            relevance: 0.92
          }
        ];

        return {
          content: [{
            type: "text",
            text: `Found ${matches.length} matches:\n${JSON.stringify(matches, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Semantic search failed: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }
  } as any);
}
