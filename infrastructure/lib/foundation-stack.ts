import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * FoundationStack — VPC, subnets, security groups, Cognito user pool,
 * S3 buckets, Secrets Manager references, and shared IAM roles.
 *
 * No resources are provisioned yet. This is a scaffold stub.
 */
export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // TODO: VPC with public/private subnets across multiple AZs
    // TODO: Cognito user pool (admin-invite-only, admin + user groups)
    // TODO: S3 bucket for audio segments (per-response, lifecycle policies)
    // TODO: Secrets Manager references: arena/claude-api-key, arena/elevenlabs-api-key
    // TODO: Shared security groups (ALB, ECS tasks, RDS, Redis)
  }
}
