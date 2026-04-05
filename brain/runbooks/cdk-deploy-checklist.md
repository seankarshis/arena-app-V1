# Runbook — CDK Production Deploy Checklist

The CDK stacks have been coded but never deployed. This runbook covers the first deploy
and everything that must be done manually afterwards for the app to start.

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

# Stack 1 — VPC, Cognito, S3, security groups, ECR, user-sync Lambda
cdk deploy ArenaFoundationStack

# Stack 2 — RDS, ElastiCache
cdk deploy ArenaDataStack

# Stack 3 — ECS, ALB, Lambdas, SQS, EventBridge
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

The CD pipeline runs migrations automatically. For the first deploy, run manually:

```bash
cd api
export DATABASE_URL="postgresql://arena:<password>@<RdsEndpointAddress>:5432/arena"
npx prisma migrate deploy
```

---

## Phase 4 — Force a new ECS deployment

After secrets are set, force new task launches so containers pick up the secret values:

```bash
aws ecs update-service \
  --cluster arena-cluster \
  --service <ApiServiceName> \
  --force-new-deployment

aws ecs update-service \
  --cluster arena-cluster \
  --service <FrontendServiceName> \
  --force-new-deployment
```

Service names are in the `ArenaComputeStack` CloudFormation outputs.

Wait for stability:
```bash
aws ecs wait services-stable \
  --cluster arena-cluster \
  --services <ApiServiceName> <FrontendServiceName>
```

---

## Phase 5 — Add ACM certificate for HTTPS

The ALB currently has an HTTP-only listener. To enable HTTPS:

1. Request a certificate in ACM for your production domain:
   ```bash
   aws acm request-certificate \
     --domain-name app.elastichorizon.com \
     --validation-method DNS
   ```

2. Add the DNS validation record to your DNS provider.

3. Once issued, update `infrastructure/lib/compute-stack.ts` to replace the HTTP listener
   with an HTTPS listener using the cert ARN, and add an HTTP→HTTPS redirect.

4. `cdk deploy ArenaComputeStack`

---

## Phase 6 — Smoke test

```bash
ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name ArenaComputeStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
  --output text)

curl -f "http://$ALB_DNS/health"       # API health
curl -f "http://$ALB_DNS/api/health"   # Frontend health
```

Both should return `200`.

---

## Notes

- The `CORS_ORIGIN` env var in ComputeStack is currently set to `http://<ALB_DNS>`.
  Once you have a real domain and ACM cert, update this to `https://app.elastichorizon.com`
  and redeploy ComputeStack.
- The S3 audio bucket CORS rule allows `*` origins. Tighten to the production domain
  once known.
- Audio upload mutations (`requestResponseAudioUploadUrl`, `requestDraftAudioUploadUrl`)
  were removed from the schema and need to be re-implemented. See ADR 003.
