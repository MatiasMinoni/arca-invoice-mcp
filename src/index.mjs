import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

import { ArcaClient } from "./arca-client.mjs";

const client = new ArcaClient();

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

function createServer() {
  const server = new McpServer({ name: "arca-invoice", version: "0.1.0" });

  server.registerTool("arca_prepare_invoice", {
    title: "Prepare ARCA invoice",
    description: "Prepare a Factura C through direct HTTP calls to official ARCA RCEL. Authentication is direct HTTP by default, with browser fallback only when explicitly configured. This tool never issues the invoice. Show the preview and obtain explicit approval before calling arca_issue_invoice.",
    inputSchema: z.object({
      receiverCuit: z.string().regex(/^\d{11}$/),
      description: z.string().min(1).max(4000),
      amount: z.number().positive(),
      emissionDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      periodFrom: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      periodTo: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      dueDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      pointOfSale: z.string().regex(/^\d{1,5}$/).default("00002"),
      paymentMethods: z.array(z.enum(["cash", "bank_transfer"])).min(1),
      captureHar: z.boolean().default(true),
    }),
  }, async input => {
    try { return result(await client.prepareInvoice(input)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("arca_issue_invoice", {
    title: "Issue prepared ARCA invoice",
    description: "Irreversibly issue the currently prepared invoice. Call only after showing the preview and receiving explicit user approval. Never retry automatically after an uncertain response.",
    inputSchema: z.object({ approvalToken: z.string().uuid() }),
  }, async input => {
    try { return result(await client.issueInvoice(input)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("arca_list_invoices", {
    title: "List issued ARCA invoices",
    description: "Read issued Factura C records from official ARCA RCEL for a date range. This tool is read-only and does not include unissued previews.",
    inputSchema: z.object({
      dateFrom: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      dateTo: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      pointOfSale: z.string().regex(/^\d{1,5}$/).default("00002"),
      receiverCuit: z.string().regex(/^\d{11}$/).optional(),
    }),
  }, async input => {
    try { return result({ invoices: await client.listInvoices(input) }); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("arca_discard_prepared_invoice", {
    title: "Discard prepared invoice",
    description: "Close the current preview without issuing an invoice.",
    inputSchema: z.object({}),
  }, async () => {
    try { return result(await client.discardPreparedInvoice()); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("arca_invoice_status", {
    title: "ARCA invoice session status",
    description: "Read whether the local ARCA session has a prepared invoice. Does not mutate ARCA.",
    inputSchema: z.object({}),
  }, async () => result(client.status()));

  return server;
}

process.once("SIGINT", async () => { await client.close(); process.exit(0); });
process.once("SIGTERM", async () => { await client.close(); process.exit(0); });

void serveStdio(createServer);
console.error("arca-invoice MCP server listening on stdio");
