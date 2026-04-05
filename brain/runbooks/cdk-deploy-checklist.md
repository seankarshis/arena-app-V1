# Runbook — CDK Deploy Checklist

The CDK stacks have been coded but never deployed. This runbook covers deploying the
managed AWS services (Cognito, RDS, ElastiCache, Lambdas) for the first time.

> **Deployment model:** App compute (API + Frontend) runs on EC2 via nginx + PM2 and is
> deployed separately via GitHub Actions (`deploy-dev.yml` / `deploy-seandev.yml`). These
> CDK stacks manage only the supporting AWS infrastructure. See ADR 004.

---

## Prerequisites

- AWS CLI configured with admin-level credentials for the target account
- CDK CLI installed: `npm install -g aws-cdk`
- CDK bootstrapped in the account/region: `cdk bootstrap aws://<account>/us-east-1`
- Docker running (CDK bundles Lambda assets locally)

---

## Phase 1 — Deploy the stacks

Deploy in order. Each stack depends on the previous.

```bash
cd infrastructure
npm install

# Stack 1 — VPC, Cognito, S3, security groups, user-sync Lambda
cdk deploy ArenaFoundationStack

# Stack 2 — RDS, ElastiCache
cdk deploy ArenaDataStack

# Stack 3 — SQS, cleaning Lambda, reconciliation Lambda, EventBridge rules
cdk deploy ArenaComputeStack
```

After each deploy, note the CfnOutputs printed to the terminal. You will need them below.

---

## Phase 2 — Set secrets in Secrets Manager

These secrets are referenced by the stacks but their **values must be set manually**.
None of this is automated — the CDK only creates the references, not the values.

Go to AWS Secrets Manager in the console (or use the CLI) and set each:

### `arena/claude-api-key`
```bash
aws secretsmanager put-secret-value \
  --secret-id arena/claude-api-key \
  --secret-string "sk-ant-..."
```

### `arena/elevenlabs-api-key`
```bash
aws secretsmanager put-secret-value \
  --secret-id arena/elevenlabs-api-key \
  --secret-string "sk_..."
```

### `arena/database-url`

The RDS endpoint is in the `ArenaDataStack` output `RdsEndpointAddress`. The password is
in the auto-generated secret `arena/rds-credentials` in Secrets Manager.

1. Get the RDS password:
   ```bash
   aws secretsmanager get-secret-value \
     --secret-id arena/rds-credentials \
     --query SecretString --output text | jq -r .password
   ```

2. Set the connection string:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id arena/database-url \
     --secret-string "postgresql://arena:<password>@<RdsEndpointAddress>:5432/arena"
   ```

### `arena/log-hash-salt`
```bash
# Generate a random value — never use a predictable string in production
aws secretsmanager put-secret-value \
  --secret-id arena/log-hash-salt \
  --secret-string "$(openssl rand -hex 32)"
```

### `arena/clickhouse-credentials`

This is a JSON secret with three keys:
```bash
aws secretsmanager put-secret-value \
  --secret-id arena/clickhouse-credentials \
  --secret-string '{
    "CLICKHOUSE_USER": "default",
    "CLICKHOUSE_PASSWORD": "...",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://..."
  }'
```

---

## Phase 3 — Run Prisma migrations

Run against the new RDS instance:

```bash
cd api
export DATABASE_URL="postgresql://arena:<password>@<RdsEndpointAddress>:5432/arena"
npx prisma migrate deploy
```

---

## Phase 4 — Point the EC2 environments at AWS services

Update the `.env.local` files on the EC2 instance to use the new managed services:

- Set `DATABASE_URL` to the RDS connection string from Phase 2
- Set `REDIS_URL` to `redis://<ElasticacheEndpoint>:6379`
- Set `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` from FoundationStack outputs

Then restart PM2:
```bash
pm2 restart seandev-api   # or arena-api for appv1
```

---

## Notes

- The S3 audio bucket CORS rule allows `*` origins. Tighten to the production domain once known.
- Audio upload mutations (`requestResponseAudioUploadUrl`, `requestDraftAudioUploadUrl`) were
  removed from the schema and need to be re-implemented. See ADR 003.
