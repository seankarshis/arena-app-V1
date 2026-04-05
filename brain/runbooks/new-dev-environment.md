# Runbook — Setting Up a New Developer Environment

This procedure sets up a new isolated dev environment on the shared EC2 alongside existing ones.

Estimated time: ~20 minutes.

---

## Step 1 — Claim your port block

Open `docs/dev-environments.md` and add a row to the table. Port blocks increment by 10:

| Environment | Frontend | API | Postgres | Redis |
|-------------|----------|-----|----------|-------|
| appv1 | 3000 | 3001 | 5432 | 6379 |
| seandev | 3010 | 3011 | 5433 | 6380 |
| **yourname** | **3020** | **3021** | **5434** | **6381** |

Commit and push this change before proceeding — it's the port registry.

---

## Step 2 — Clone the repo on the EC2

SSH into the EC2, then:

```bash
cd /home/ubuntu/arena-app
git clone <repo-url> yourname
cd yourname
```

---

## Step 3 — Configure Docker Compose

Edit `docker-compose.yml` to use your port block:

```yaml
services:
  postgres:
    image: postgres:15
    container_name: yourname_postgres
    environment:
      POSTGRES_USER: arena
      POSTGRES_PASSWORD: arena_local
      POSTGRES_DB: arena_yourname
    ports:
      - "5434:5432"
    volumes:
      - yourname_pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    container_name: yourname_redis
    ports:
      - "6381:6379"

volumes:
  yourname_pgdata:
```

Start the containers:

```bash
docker compose up -d
```

---

## Step 4 — Create your environment file

```bash
cp api/.env.example api/.env.local
```

Edit `api/.env.local` — at minimum set:

```bash
OTEL_CLIENT_INSTALL_ID=yourname
DATABASE_URL=postgresql://arena:arena_local@localhost:5434/arena_yourname
REDIS_URL=redis://localhost:6381
```

Leave the bypass flags enabled (`COGNITO_BYPASS=true`, `ELEVENLABS_MOCK=true`, `CONSENT_BYPASS=true`).

---

## Step 5 — Run migrations and seed

```bash
cd api
npm install
npx prisma migrate deploy
npx prisma db seed
cd ..
```

---

## Step 6 — Install frontend dependencies and build

```bash
cd frontend
npm install
npm run build
cd ..
```

---

## Step 7 — Create the nginx vhost

Write the config file (replace `yourname` and port numbers throughout):

```bash
sudo tee /etc/nginx/sites-available/yourname > /dev/null << 'NGINXEOF'
server {
    server_name yourname.elastichorizon.com;

    location /graphql {
        proxy_pass http://localhost:3021;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://localhost:3021;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location /stt {
        proxy_pass http://localhost:3021;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://localhost:3020;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    listen 80;
}
NGINXEOF

sudo ln -s /etc/nginx/sites-available/yourname /etc/nginx/sites-enabled/yourname
sudo nginx -t && sudo systemctl reload nginx
```

> **Important:** The `NGINXEOF` delimiter must be at column 0 (no leading spaces). If your
> terminal adds indentation, type it manually rather than pasting.

---

## Step 8 — Point DNS to the EC2

Create a DNS A record for `yourname.elastichorizon.com` pointing to the EC2's public IP.
The EC2's public IP doesn't change unless it's stopped. Confirm the record has propagated
before continuing.

---

## Step 9 — Issue the SSL certificate

```bash
sudo certbot --nginx -d yourname.elastichorizon.com
```

Follow the prompts. Certbot will auto-add the SSL blocks to your nginx config.

---

## Step 10 — Start processes via PM2

```bash
# From the repo root
PORT=3021 pm2 start --name yourname-api -- bash -c "cd api && npm run dev"
PORT=3020 pm2 start --name yourname-frontend -- bash -c "cd frontend && npm start"
pm2 save
```

---

## Step 11 — Add a deploy workflow

Create `.github/workflows/deploy-yourname.yml` in the repo:

```yaml
name: Deploy — yourname

on:
  push:
    branches: [main]

jobs:
  deploy:
    uses: ./.github/workflows/_deploy-ec2-env.yml
    with:
      app_path: /home/ubuntu/arena-app/yourname
      api_pm2_name: yourname-api
      frontend_pm2_name: yourname-frontend
    secrets:
      EC2_SSH_KEY: ${{ secrets.EC2_SSH_KEY }}
      EC2_HOST: ${{ secrets.EC2_HOST }}
      EC2_USERNAME: ${{ secrets.EC2_USERNAME }}
```

Commit and push. From this point, every push to `main` will automatically deploy to your environment.

---

## Verification

Visit `https://yourname.elastichorizon.com/login` — you should see the login page over HTTPS.

Check PM2 status: `pm2 list` — both processes should be `online`.
