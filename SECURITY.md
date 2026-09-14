# Security policy

This MCP handles tax credentials and can issue legally relevant invoices. Treat every deployment, log and artifact as sensitive.

## Never publish

- `.env` or credential files;
- CUIL/password values, cookies, JWTs or approval tokens;
- `.state/` browser profiles;
- HAR captures, official PDFs or taxpayer/customer information;
- private keys or certificates.

The repository ignores common forms of these artifacts, but ignore rules are not a substitute for reviewing every commit before pushing.

## Reporting

Report security issues privately to the repository owner. Do not open a public issue containing credentials, session material, invoice data or steps that operate a real taxpayer account.

## Safe operation

- Keep browser fallback disabled unless it is explicitly required and supervised.
- Review every preview and obtain explicit human approval before issuance.
- After an uncertain issuance response, query ARCA before attempting any further action.
- Run the MCP only for accounts and taxpayers you are authorized to operate.
