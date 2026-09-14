import assert from "node:assert/strict";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cwd = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(cwd, "src", "index.mjs")],
  cwd,
  stderr: "pipe",
});
const client = new Client({ name: "arca-invoice-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const response = await client.listTools();
  assert.deepEqual(
    response.tools.map(tool => tool.name).sort(),
    [
      "arca_discard_prepared_invoice",
      "arca_invoice_status",
      "arca_issue_invoice",
      "arca_list_invoices",
      "arca_prepare_invoice",
    ],
  );
  console.log(`MCP smoke passed: ${response.tools.length} tools`);
} finally {
  await client.close();
}
