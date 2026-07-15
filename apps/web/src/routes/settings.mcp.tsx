import { createFileRoute } from "@tanstack/react-router";

import { McpSettingsPanel } from "../components/settings/McpSettings";

export const Route = createFileRoute("/settings/mcp")({
  component: McpSettingsPanel,
});
