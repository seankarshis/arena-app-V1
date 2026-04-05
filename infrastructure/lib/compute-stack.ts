import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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

    // ── Stack Outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CleaningQueueUrl', {
      value: this.cleaningQueue.queueUrl,
      description: 'Cleaning SQS Queue URL',
    });

    new cdk.CfnOutput(this, 'CleaningDlqUrl', {
      value: this.cleaningDlq.queueUrl,
      description: 'Cleaning Dead-Letter Queue URL',
    });
  }
}
