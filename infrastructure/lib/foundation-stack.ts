import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * FoundationStack — VPC, subnets, security groups, Cognito user pool,
 * S3 audio bucket, Secrets Manager references, and the user-sync Lambda
 * (must live here to avoid a cross-stack Cognito trigger cycle — see ADR 002).
 */
export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly redisSg: ec2.SecurityGroup;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userSyncLambda: lambda.Function;
  public readonly audioBucket: s3.Bucket;
  public readonly claudeApiKeySecret: secretsmanager.ISecret;
  public readonly elevenlabsApiKeySecret: secretsmanager.ISecret;
  public readonly databaseUrlSecret: secretsmanager.ISecret;
  public readonly logHashSaltSecret: secretsmanager.ISecret;
  public readonly clickhouseCredentialsSecret: secretsmanager.ISecret;
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ───────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'ArenaVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ── Security Groups ────────────────────────────────────────────────
    // Lambda functions: outbound only (reach RDS + Redis inside the VPC)
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Lambda functions — outbound to RDS/Redis inside VPC',
      allowAllOutbound: true,
    });

    // RDS: inbound from Lambda on 5432 only
    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: 'RDS — inbound PostgreSQL from Lambda functions only',
      allowAllOutbound: false,
    });
    this.rdsSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(5432), 'PostgreSQL from Lambda');

    // Redis: inbound from Lambda on 6379 only
    this.redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      description: 'Redis — inbound from Lambda functions only',
      allowAllOutbound: false,
    });
    this.redisSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(6379), 'Redis from Lambda');

    // ── Secrets Manager References ─────────────────────────────────────
    // Values are set manually by operators — we only reference existing secrets.
    this.claudeApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ClaudeApiKeySecret',
      'arena/claude-api-key',
    );

    this.elevenlabsApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ElevenlabsApiKeySecret',
      'arena/elevenlabs-api-key',
    );

    this.databaseUrlSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'DatabaseUrlSecret',
      'arena/database-url',
    );

    this.logHashSaltSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LogHashSaltSecret',
      'arena/log-hash-salt',
    );

    // JSON secret with keys CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, OTEL_EXPORTER_OTLP_ENDPOINT
    this.clickhouseCredentialsSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ClickhouseCredentialsSecret',
      'arena/clickhouse-credentials',
    );

    // ── Cognito User Pool ─────────────────────────────────────────────
    // Admin-invite-only: no self-signup, email sign-in
    this.userPool = new cognito.UserPool(this, 'ArenaUserPool', {
      userPoolName: 'arena-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Groups
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Platform administrators — full access',
    });

    new cognito.CfnUserPoolGroup(this, 'UserGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'user',
      description: 'Interview candidates — own interviews only',
    });

    // App client — no secret (used by browser-based frontend)
    this.userPoolClient = this.userPool.addClient('ArenaAppClient', {
      userPoolClientName: 'arena-frontend',
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'ArenaUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID (frontend)',
      exportName: 'ArenaUserPoolClientId',
    });

    // ── Lambda: User Sync Handler ─────────────────────────────────────
    // Lives in FoundationStack (not ComputeStack) to avoid a cross-stack
    // Cognito trigger dependency cycle. Only needs databaseUrlSecret and
    // VPC — both available here.
    const lambdaCodePath = path.join(__dirname, '../../api/src/lambda');

    const userSyncLogGroup = new logs.LogGroup(this, 'UserSyncLambdaLogs', {
      logGroupName: '/aws/lambda/arena-user-sync',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userSyncLambda = new lambda.Function(this, 'UserSyncLambda', {
      functionName: 'arena-user-sync',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'user-sync-handler.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: userSyncLogGroup,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.lambdaSg],
      environment: {
        // Resolved at deploy time via CloudFormation dynamic reference.
        // TODO: migrate to Lambda Secrets Manager extension for rotation support.
        DATABASE_URL: this.databaseUrlSecret.secretValue.unsafeUnwrap(),
      },
    });

    this.databaseUrlSecret.grantRead(this.userSyncLambda);

    // Wire PostConfirmation trigger — safe here because Lambda and UserPool
    // are in the same stack (no cross-stack cycle).
    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      this.userSyncLambda,
    );

    // ── S3 Audio Bucket ───────────────────────────────────────────────
    this.audioBucket = new s3.Bucket(this, 'AudioBucket', {
      bucketName: `arena-audio-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-audio-segments',
          expiration: cdk.Duration.days(90),
          enabled: true,
        },
      ],
      cors: [
        {
          // Tighten to the production domain once known
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    new cdk.CfnOutput(this, 'AudioBucketName', {
      value: this.audioBucket.bucketName,
      description: 'S3 bucket for per-response audio segments',
      exportName: 'ArenaAudioBucketName',
    });

  }
}
