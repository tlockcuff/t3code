import { describe, expect, it } from "vite-plus/test";

import { parseMcpConfigDocument, parseMcpServerEntry } from "./claudeMcpConfig.ts";
import { assertNotFlagLike, buildAddArgs, parseMcpListOutput } from "./claudeMcpCli.ts";

describe("parseMcpServerEntry", () => {
  it("reads an stdio server and keeps env key names without values", () => {
    const row = parseMcpServerEntry({
      name: "aws-api-mcp",
      scope: "user",
      entry: {
        type: "stdio",
        command: "uvx",
        args: ["awslabs.aws-api-mcp-server@latest"],
        env: { AWS_REGION: "us-east-1", FASTMCP_LOG_LEVEL: "ERROR" },
      },
    });

    expect(row).toEqual({
      name: "aws-api-mcp",
      transport: "stdio",
      scope: "user",
      command: "uvx",
      args: ["awslabs.aws-api-mcp-server@latest"],
      envKeys: ["AWS_REGION", "FASTMCP_LOG_LEVEL"],
    });
  });

  it("never leaks header values — a bearer token must not survive parsing", () => {
    const row = parseMcpServerEntry({
      name: "mojoactive-docs",
      scope: "user",
      entry: {
        type: "http",
        url: "https://docs.mojoactive.dev/api/mcp",
        headers: { Authorization: "Bearer mcp_supersecrettoken" },
      },
    });

    expect(row?.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(row)).not.toContain("supersecrettoken");
  });

  it("infers stdio from a bare command when `type` is absent", () => {
    const row = parseMcpServerEntry({
      name: "convex",
      scope: "project",
      projectPath: "/Users/dev/app",
      entry: { command: "npx", args: ["convex", "mcp", "start"] },
    });

    expect(row?.transport).toBe("stdio");
    expect(row?.projectPath).toBe("/Users/dev/app");
  });

  it("preserves the sse transport rather than collapsing it to http", () => {
    const row = parseMcpServerEntry({
      name: "linear-server",
      scope: "project",
      entry: { type: "sse", url: "https://mcp.linear.app/sse" },
    });

    expect(row?.transport).toBe("sse");
    expect(row?.url).toBe("https://mcp.linear.app/sse");
  });

  it("rejects a non-object entry instead of throwing", () => {
    expect(parseMcpServerEntry({ name: "bad", scope: "user", entry: "nope" })).toBeNull();
  });
});

describe("parseMcpConfigDocument", () => {
  it("collects both user-scope and project-scope servers", () => {
    const servers = parseMcpConfigDocument({
      mcpServers: {
        posthog: { type: "http", url: "https://mcp.posthog.com/mcp" },
      },
      projects: {
        "/Users/dev/app": {
          mcpServers: { convex: { command: "npx", args: ["convex", "mcp", "start"] } },
        },
        "/Users/dev/no-mcp": {},
      },
    });

    expect(servers).toHaveLength(2);
    expect(servers.map((server) => [server.name, server.scope])).toEqual([
      ["convex", "project"],
      ["posthog", "user"],
    ]);
  });

  it("returns empty for a config with no MCP servers at all", () => {
    expect(parseMcpConfigDocument({ numStartups: 12 })).toEqual([]);
    expect(parseMcpConfigDocument(null)).toEqual([]);
  });
});

describe("parseMcpListOutput", () => {
  it("parses the real CLI health output, including the header line", () => {
    const rows = parseMcpListOutput(
      [
        "Checking MCP server health…",
        "",
        "claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected",
        "claude.ai Stripe: https://mcp.stripe.com - ! Needs authentication",
        "cost-explorer: uvx awslabs.cost-explorer-mcp-server@latest - ✔ Connected",
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        name: "claude.ai Linear",
        health: "connected",
        detail: "✔ Connected",
      },
      {
        name: "claude.ai Stripe",
        health: "needs_auth",
        detail: "! Needs authentication",
      },
      {
        name: "cost-explorer",
        health: "connected",
        detail: "✔ Connected",
      },
    ]);
  });

  it("keeps a url containing a dash intact by splitting on the last separator", () => {
    const rows = parseMcpListOutput("my-server: https://a-b.example.com/mcp - ✔ Connected");
    expect(rows[0]?.name).toBe("my-server");
    expect(rows[0]?.health).toBe("connected");
  });

  it("degrades an unrecognized status to unknown rather than failing", () => {
    const rows = parseMcpListOutput("weird: https://x.dev/mcp - ✱ Reticulating splines");
    expect(rows[0]?.health).toBe("unknown");
  });
});

describe("buildAddArgs", () => {
  it("separates a stdio command from its args with `--`", () => {
    expect(
      buildAddArgs({
        name: "my-server",
        transport: "stdio",
        scope: "user",
        target: "npx",
        args: ["my-mcp-server", "--some-flag"],
        env: ["API_KEY=xxx"],
      }),
    ).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "--env",
      "API_KEY=xxx",
      "--",
      "my-server",
      "npx",
      "my-mcp-server",
      "--some-flag",
    ]);
  });

  it("passes an http url positionally with its headers", () => {
    expect(
      buildAddArgs({
        name: "sentry",
        transport: "http",
        scope: "user",
        target: "https://mcp.sentry.dev/mcp",
        headers: ["Authorization: Bearer abc"],
      }),
    ).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "--header",
      "Authorization: Bearer abc",
      "--",
      "sentry",
      "https://mcp.sentry.dev/mcp",
    ]);
  });

  it("puts a `--` sentinel before positionals in every transport", () => {
    // Regression: without the sentinel, a leading-dash name reaches the
    // `claude` parser as a flag. The real CLI was verified to create a server
    // literally named `--help` when this was missing.
    for (const transport of ["stdio", "http", "sse"] as const) {
      const args = buildAddArgs({
        name: "n",
        transport,
        scope: "user",
        target: transport === "stdio" ? "npx" : "https://x.dev/mcp",
      });
      const sentinel = args.indexOf("--");
      expect(sentinel).toBeGreaterThan(-1);
      // The name must come after the sentinel, never before it.
      expect(args.indexOf("n")).toBeGreaterThan(sentinel);
    }
  });
});

describe("assertNotFlagLike", () => {
  const base = { transport: "http", scope: "user", target: "https://x.dev/mcp" } as const;

  it("rejects a flag-like server name", () => {
    expect(assertNotFlagLike({ ...base, name: "--help" })).not.toBeNull();
  });

  it("rejects a flag-like target", () => {
    expect(assertNotFlagLike({ ...base, name: "ok", target: "--version" })).not.toBeNull();
  });

  it("accepts ordinary values", () => {
    expect(assertNotFlagLike({ ...base, name: "my-server" })).toBeNull();
  });
});
