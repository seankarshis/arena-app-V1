import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';
import { DataStack } from './data-stack';

export interface ComputeStackProps extends cdk.StackProps {
  foundationStack: FoundationStack;
  dataStack: DataStack;
}

/**
 * ComputeStack — ECS Fargate cluster, ALB with path-based routing,
 * API and Frontend services, Lambda functions for cleaning and
 * reconciliation, SQS queues, and EventBridge rules.
 */
export class ComputeStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly apiService: ecs.FargateService;
  public readonly frontendService: ecs.FargateService;
  public readonly cleaningQueue: sqs.Queue;
  public readonly cleaningDlq: sqs.Queue;
  public readonly cleaningLambda: lambda.Function;
  public readonly reconciliationLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // ── ECS Cluster ───────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'ArenaCluster', {
      vpc: props.foundationStack.vpc,
      clusterName: 'arena-cluster',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── Application Load Balancer ─────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ArenaAlb', {
      vpc: props.foundationStack.vpc,
      internetFacing: true,
      securityGroup: props.foundationStack.albSg,
    });

    const listener = this.alb.addListener('HttpListener', {
      port: 80,
    });

    // ── API Fargate Service ───────────────────────────────────────────
    // Spec: 1 vCPU, 2GB, min 2 tasks, max 4 tasks (auto-scaling on CPU)
    const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    apiTaskDef.addContainer('api', {
      image: ecs.ContainerImage.fromEcrRepository(props.foundationStack.apiRepo, 'latest'),
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'arena-api',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        PORT: '3001',
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
        AWS_REGION: 'us-east-1',
        S3_REGION: 'us-east-1',
        COGNITO_REGION: 'us-east-1',
        COGNITO_USER_POOL_ID: props.foundationStack.userPool.userPoolId,
        S3_AUDIO_BUCKET: props.foundationStack.audioBucket.bucketName,
        EVENT_BUS_NAME: 'arena-event-bus',
        OTEL_SERVICE_NAME: 'arena-api',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_CLIENT_INSTALL_ID: 'production',
        CORS_ORIGIN: `http://${this.alb.loadBalancerDnsName}`,
        REDIS_URL: `redis://${props.dataStack.redisCluster.attrRedisEndpointAddress}:${props.dataStack.redisCluster.attrRedisEndpointPort}`,
      },
      secrets: {
        CLAUDE_API_KEY: ecs.Secret.fromSecretsManager(props.foundationStack.claudeApiKeySecret),
        ELEVENLABS_API_KEY: ecs.Secret.fromSecretsManager(
          props.foundationStack.elevenlabsApiKeySecret,
        ),
        DATABASE_URL: ecs.Secret.fromSecretsManager(props.foundationStack.databaseUrlSecret),
        LOG_HASH_SALT: ecs.Secret.fromSecretsManager(props.foundationStack.logHashSaltSecret),
        // arena/clickhouse-credentials is a JSON secret with these keys:
        CLICKHOUSE_USER: ecs.Secret.fromSecretsManager(
          props.foundationStack.clickhouseCredentialsSecret,
          'CLICKHOUSE_USER',
        ),
        CLICKHOUSE_PASSWORD: ecs.Secret.fromSecretsManager(
          props.foundationStack.clickhouseCredentialsSecret,
          'CLICKHOUSE_PASSWORD',
        ),
        OTEL_EXPORTER_OTLP_ENDPOINT: ecs.Secret.fromSecretsManager(
          props.foundationStack.clickhouseCredentialsSecret,
          'OTEL_EXPORTER_OTLP_ENDPOINT',
        ),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3001/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(60),
        retries: 3,
      },
    });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster: this.cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [props.foundationStack.ecsSg],
    });

    const apiScaling = this.apiService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 4,
    });
    apiScaling.scaleOnCpuUtilization('ApiCpuScaling', {
      targetUtilizationPercent: 70,
    });

    // ── API Task Role — IAM grants ────────────────────────────────────
    props.foundationStack.claudeApiKeySecret.grantRead(apiTaskDef.taskRole);
    props.foundationStack.elevenlabsApiKeySecret.grantRead(apiTaskDef.taskRole);
    props.foundationStack.databaseUrlSecret.grantRead(apiTaskDef.taskRole);
    props.foundationStack.logHashSaltSecret.grantRead(apiTaskDef.taskRole);
    props.foundationStack.clickhouseCredentialsSecret.grantRead(apiTaskDef.taskRole);
    props.foundationStack.audioBucket.grantReadWrite(apiTaskDef.taskRole);
    apiTaskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [
          `arn:aws:events:us-east-1:${this.account}:event-bus/arena-event-bus`,
        ],
      }),
    );

    // ── Frontend Fargate Service ──────────────────────────────────────
    // Spec: 0.5 vCPU, 1GB, min 2 tasks
    const frontendTaskDef = new ecs.FargateTaskDefinition(this, 'FrontendTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    frontendTaskDef.addContainer('frontend', {
      image: ecs.ContainerImage.fromEcrRepository(props.foundationStack.frontendRepo, 'latest'),
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'arena-frontend',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3001',
        HOSTNAME: '0.0.0.0',
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_PUBLIC_GRAPHQL_URL: `http://${this.alb.loadBalancerDnsName}/graphql`,
        NEXT_PUBLIC_API_URL: `http://${this.alb.loadBalancerDnsName}`,
        NEXT_PUBLIC_STT_WS_URL: `ws://${this.alb.loadBalancerDnsName}/stt`,
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: props.foundationStack.userPool.userPoolId,
        NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID:
          props.foundationStack.userPoolClient.userPoolClientId,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3001/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        startPeriod: cdk.Duration.seconds(10),
        retries: 3,
      },
    });

    this.frontendService = new ecs.FargateService(this, 'FrontendService', {
      cluster: this.cluster,
      taskDefinition: frontendTaskDef,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [props.foundationStack.ecsSg],
    });

    // ── ALB Path-Based Routing ────────────────────────────────────────
    // /graphql and /api/* → API service; everything else → Frontend
    listener.addTargets('ApiTargets', {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.apiService],
      healthCheck: {
        path: '/health',
        port: '3001',
        healthyHttpCodes: '200',
      },
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/graphql', '/graphql/*', '/api/*']),
      ],
      priority: 10,
    });

    listener.addTargets('FrontendTargets', {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.frontendService],
      healthCheck: {
        path: '/api/health',
        port: '3001',
        healthyHttpCodes: '200',
      },
    });

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
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name',
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });

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
