import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

/**
 * ComputeStack — background compute: SQS cleaning queue, cleaning Lambda,
 * reconciliation Lambda, and EventBridge rules.
 *
 * App compute (API + Frontend) runs on EC2 via nginx + PM2. See ADR 004.
 */
export class ComputeStack extends cdk.Stack {
  public readonly cleaningQueue: sqs.Queue;
  public readonly cleaningDlq: sqs.Queue;
  public readonly cleaningLambda: lambda.Function;
  public readonly reconciliationLambda: lambda.Function;
  public readonly enrichmentQueue: sqs.Queue;
  public readonly enrichmentDlq: sqs.Queue;
  public readonly enrichmentLambda: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── SQS: Cleaning Dead-Letter Queue ──────────────────────────────
    this.cleaningDlq = new sqs.Queue(this, 'CleaningDlq', {
      queueName: 'arena-cleaning-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // ── SQS: Cleaning Queue ──────────────────────────────────────────
    this.cleaningQueue = new sqs.Queue(this, 'CleaningQueue', {
      queueName: 'arena-cleaning-queue',
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: this.cleaningDlq,
        maxReceiveCount: 3,
      },
    });

    // ── Lambda: Cleaning Handler ─────────────────────────────────────
    const lambdaCodePath = path.join(__dirname, '../../api/src/lambda');

    const cleaningLogGroup = new logs.LogGroup(this, 'CleaningLambdaLogs', {
      logGroupName: '/aws/lambda/arena-cleaning',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.cleaningLambda = new lambda.Function(this, 'CleaningLambda', {
      functionName: 'arena-cleaning',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'cleaning-handler.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: cleaningLogGroup,
    });

    // SQS triggers cleaning Lambda
    this.cleaningLambda.addEventSource(
      new lambdaEvents.SqsEventSource(this.cleaningQueue, {
        batchSize: 1,
      }),
    );

    // ── EventBridge: Interview Completion → Cleaning Queue ───────────
    new events.Rule(this, 'InterviewCompletionRule', {
      ruleName: 'arena-interview-completion',
      eventPattern: {
        source: ['arena.interview'],
        detailType: ['InterviewCompleted'],
      },
    }).addTarget(new targets.SqsQueue(this.cleaningQueue));

    // ── Lambda: Reconciliation Handler ───────────────────────────────
    const reconciliationLogGroup = new logs.LogGroup(this, 'ReconciliationLambdaLogs', {
      logGroupName: '/aws/lambda/arena-reconciliation',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.reconciliationLambda = new lambda.Function(this, 'ReconciliationLambda', {
      functionName: 'arena-reconciliation',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'reconciliation-handler.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: reconciliationLogGroup,
    });

    // ── EventBridge: 15-Minute Reconciliation Schedule ────────────────
    new events.Rule(this, 'ReconciliationSchedule', {
      ruleName: 'arena-reconciliation-schedule',
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    }).addTarget(new targets.LambdaFunction(this.reconciliationLambda));

    // ── SQS: Enrichment Dead-Letter Queue ────────────────────────────
    this.enrichmentDlq = new sqs.Queue(this, 'EnrichmentDlq', {
      queueName: 'arena-enrichment-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // ── SQS: Enrichment Queue ─────────────────────────────────────────
    this.enrichmentQueue = new sqs.Queue(this, 'EnrichmentQueue', {
      queueName: 'arena-enrichment-queue',
      // Visibility timeout must exceed Lambda timeout (5 min → 6 min headroom)
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: {
        queue: this.enrichmentDlq,
        maxReceiveCount: 3,
      },
    });

    // ── Lambda: Enrichment Handler ────────────────────────────────────
    const enrichmentLogGroup = new logs.LogGroup(this, 'EnrichmentLambdaLogs', {
      logGroupName: '/aws/lambda/arena-enrichment',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.enrichmentLambda = new lambda.Function(this, 'EnrichmentLambda', {
      functionName: 'arena-enrichment',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'enrichment-handler.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: enrichmentLogGroup,
      environment: {
        // ANTHROPIC_API_KEY is injected at runtime from Secrets Manager via
        // the grant below; the env var name is set explicitly for clarity.
        // DATABASE_URL is supplied via the shared VPC/SG pattern (set at deploy time).
      },
    });

    // Grant Secrets Manager read access for arena/claude-api-key
    const claudeApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ClaudeApiKeySecret',
      'arena/claude-api-key',
    );
    claudeApiKeySecret.grantRead(this.enrichmentLambda);

    // Inject the secret value as ANTHROPIC_API_KEY via environment variable
    // (resolved at deploy time by CDK; value comes from Secrets Manager)
    this.enrichmentLambda.addEnvironment(
      'ANTHROPIC_API_KEY',
      claudeApiKeySecret.secretValue.unsafeUnwrap(),
    );

    // SQS triggers enrichment Lambda (batch size 1 to isolate per-message failures)
    this.enrichmentLambda.addEventSource(
      new lambdaEvents.SqsEventSource(this.enrichmentQueue, {
        batchSize: 1,
      }),
    );

    // IAM: allow enrichment Lambda to write ClickHouse OTLP telemetry
    // (outbound HTTPS — no AWS IAM policy needed for external ClickHouse HTTP,
    // but grant CloudWatch Logs write access for structured log output)
    this.enrichmentLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [enrichmentLogGroup.logGroupArn],
      }),
    );

    // ── Stack Outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CleaningQueueUrl', {
      value: this.cleaningQueue.queueUrl,
      description: 'Cleaning SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'CleaningDlqUrl', {
      value: this.cleaningDlq.queueUrl,
      description: 'Cleaning Dead-Letter Queue URL',
    });

    new cdk.CfnOutput(this, 'EnrichmentQueueUrl', {
      value: this.enrichmentQueue.queueUrl,
      description: 'Enrichment SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'EnrichmentDlqUrl', {
      value: this.enrichmentDlq.queueUrl,
      description: 'Enrichment Dead-Letter Queue URL',
    });
  }
}
