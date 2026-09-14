# ARCA Invoice MCP

Local MCP server for preparing and issuing ARCA Factura C invoices through the official RCEL protocol.

Authentication uses direct HTTP by default, including the JSF login, JWT bridge, portal service grant, RCEL SSO, and taxpayer selection. Browser fallback is disabled: if direct authentication fails, the MCP returns the error without opening Chrome. A browser can only be enabled explicitly with `ARCA_AUTH_FALLBACK=headless` or `ARCA_AUTH_FALLBACK=visible`. The invoice flow itself always uses direct HTTP requests reconstructed from an observed HAR.

The server deliberately separates preview from issuance:

1. `arca_prepare_invoice` sends the four RCEL form requests, records a HAR, and returns a structured preview plus a one-time approval token.
2. A human reviews the returned summary.
3. `arca_issue_invoice` requires the exact token, re-reads the preview, emits once, downloads the official PDF, and flushes a full HAR.

`arca_list_invoices` queries issued Factura C records by date range directly from RCEL. Prepared or discarded previews never appear in that list because ARCA has not assigned them a number or CAE.

## Security

- Keep `CUIL` and `PASS` only in `.env`; the file is ignored by Git.
- HAR, browser state, and PDFs are ignored by Git.
- HAR files can contain session cookies and taxpayer/customer information. They are written with owner-only permissions and must be treated as credentials.
- The client refuses to send ARCA data to hosts outside the official AFIP/ARCA domains.
- Authentication requests are intentionally excluded from HAR so the password is never recorded. RCEL cookies are redacted in the generated HAR.
- If issuance returns an uncertain result, do not retry. Check `Consultas` in RCEL first.
- Use this project only with an ARCA account and taxpayer you are authorized to operate.

See [SECURITY.md](SECURITY.md) before sharing logs or reporting a vulnerability.

## Requirements

- Node.js 20 or newer.
- `pdftotext` from Poppler, used to verify the official number and CAE after issuance.
- Google Chrome only if an explicit authentication fallback is enabled.

## Run

```bash
npm ci
cp .env.example .env
# Complete CUIL and PASS in .env without committing it.
npm start
```

Use either `npm ci` or `npm install`; `npm ci` is recommended when using the committed lockfile.

The server uses Google Chrome on macOS by default. Override it with `ARCA_CHROME_PATH`. Set `ARCA_HEADLESS=1` only after validating that ARCA accepts the environment.

Example Codex MCP configuration:

```toml
[mcp_servers.arca_invoice]
command = "node"
args = ["/absolute/path/to/arca-invoice-mcp/src/index.mjs"]
cwd = "/absolute/path/to/arca-invoice-mcp"
```

## Validate locally

These checks do not authenticate with ARCA or issue invoices:

```bash
npm run check
npm test
npm audit --omit=dev
```

## Operational warning

`arca_issue_invoice` performs an irreversible external action. Always present the preview to a human, receive explicit approval for that exact preview, and call the issue tool only once. Never commit or share `.env`, `.state`, PDFs, HAR files, cookies, approval tokens, taxpayer data, or customer data.
