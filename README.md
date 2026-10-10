# Aegira

Aegira: an operation gateway that lets AI agents act with permissions, approvals, and audit logs.

## Viewing locally

Since this is a static site, you can open `index.html` directly in your browser.

## Deploying to Cloudflare Pages

This project is set up for Cloudflare Pages with no build step.

- Build command: `none`
- Output directory: `/`

Connect your repository to Cloudflare Pages and it will deploy automatically.

## Admin setup

To enable the admin page and API, you must set the following secrets in your Cloudflare Pages environment:

- `AEGIRA_ADMIN_PASSWORD`: The password for HTTP Basic authentication to access the `/admin` page.
- `AEGIRA_ADMIN_KEY`: The Bearer token for authenticating to the `/v1/admin/*` API endpoints.
- `AEGIRA_ADMIN_ALLOW_IPS` (optional): A comma-separated list of IPv4 or IPv6 addresses that are allowed to access the admin interfaces.

You can set these secrets using the Cloudflare Dashboard or with Wrangler:

```bash
npx wrangler pages secret put AEGIRA_ADMIN_PASSWORD --project-name aegira
npx wrangler pages secret put AEGIRA_ADMIN_KEY --project-name aegira
npx wrangler pages secret put AEGIRA_ADMIN_ALLOW_IPS --project-name aegira   # optional
```

## License

This project is open source and available under the MIT License.
