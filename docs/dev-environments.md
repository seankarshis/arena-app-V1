# Dev Environments

Each developer environment runs on the shared EC2 with its own subdomain, port range, and isolated database/Redis.

## Port Assignments

| Environment | Subdomain                        | Frontend | API  | Postgres | Redis |
|-------------|----------------------------------|----------|------|----------|-------|
| appv1       | appv1.elastichorizon.com         | 3000     | 3001 | 5432     | 6379  |
| seandev     | seandev.elastichorizon.com       | 3010     | 3011 | 5433     | 6380  |
| _(next)_    | _<name>.elastichorizon.com_      | 3020     | 3021 | 5434     | 6381  |

## Adding a New Environment

1. **Claim a port block** — add a row to the table above (increment by 10 for app ports, 1 for DB/Redis).
2. **Docker Compose** — copy `docker-compose.yml`, update the port mappings and container names.
3. **nginx vhost** — create `/etc/nginx/sites-available/<name>` pointing to your frontend/API ports, enable it, test and reload nginx.
4. **SSL cert** — `sudo certbot --nginx -d <name>.elastichorizon.com`
5. **Environment file** — create `.env.local` with `DATABASE_URL`, `REDIS_URL`, and the bypass flags for local dev.
6. **Start processes** — `PORT=<api-port> npm run dev` (API) and `PORT=<frontend-port> npm run dev` (frontend), managed via PM2.
7. **Save PM2** — `pm2 save` so processes survive reboots.

## Environment Variables

See `api/.env.example` and `frontend/.env.example` for all required and optional
environment variables with descriptions.

In development, copy these to `api/.env.local` and `frontend/.env.local` and fill in values.
Production values should be stored in AWS Secrets Manager under the `arena/` prefix.
