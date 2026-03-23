import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * FoundationStack — VPC, subnets, security groups, Cognito user pool,
 * S3 buckets, Secrets Manager references, and shared IAM roles.
 *
 * No resources are provisioned yet. This is a scaffold stub.
 */
export class FoundationStack extends cdk.Stack {
  public readonly apiRepo: ecr.Repository;
  public readonly frontendRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // TODO: VPC with public/private subnets across multiple AZs
    // TODO: Cognito user pool (admin-invite-only, admin + user groups)
    // TODO: S3 bucket for audio segments (per-response, lifecycle policies)
    // TODO: Secrets Manager references: arena/claude-api-key, arena/elevenlabs-api-key
    // TODO: Shared security groups (ALB, ECS tasks, RDS, Redis)

    // ── ECR Repositories ────────────────────────────────────────────────
    this.apiRepo = new ecr.Repository(this, 'ApiRepo', {
      repositoryName: 'arena-api',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    this.frontendRepo = new ecr.Repository(this, 'FrontendRepo', {
      repositoryName: 'arena-frontend',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    new cdk.CfnOutput(this, 'ApiRepoUri', {
      value: this.apiRepo.repositoryUri,
      description: 'API ECR repository URI',
      exportName: 'ArenaApiRepoUri',
    });

    new cdk.CfnOutput(this, 'FrontendRepoUri', {
      value: this.frontendRepo.repositoryUri,
      description: 'Frontend ECR repository URI',
      exportName: 'ArenaFrontendRepoUri',
    });
  }
}
