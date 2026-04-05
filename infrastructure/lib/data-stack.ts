import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';

export interface DataStackProps extends cdk.StackProps {
  foundationStack: FoundationStack;
}

/**
 * DataStack — RDS PostgreSQL and ElastiCache Redis.
 *
 * SQS queues and EventBridge rules for the cleaning pipeline live in ComputeStack.
 */
export class DataStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly redisCluster: elasticache.CfnCacheCluster;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // ── RDS PostgreSQL 15 ──────────────────────────────────────────────────
    this.database = new rds.DatabaseInstance(this, 'ArenaDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: props.foundationStack.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.foundationStack.rdsSg],
      databaseName: 'arena',
      credentials: rds.Credentials.fromGeneratedSecret('arena', {
        secretName: 'arena/rds-credentials',
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      multiAz: false,
      deletionProtection: false,
      publiclyAccessible: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Outputs — operators use these to populate arena/database-url:
    // postgresql://arena:<password>@<RdsEndpointAddress>:5432/arena
    new cdk.CfnOutput(this, 'RdsEndpointAddress', {
      value: this.database.dbInstanceEndpointAddress,
      description:
        'RDS endpoint. Set arena/database-url to: postgresql://arena:<password>@<endpoint>:5432/arena',
      exportName: 'ArenaRdsEndpointAddress',
    });

    new cdk.CfnOutput(this, 'RdsEndpointPort', {
      value: this.database.dbInstanceEndpointPort,
      description: 'RDS PostgreSQL port',
      exportName: 'ArenaRdsEndpointPort',
    });

    // ── ElastiCache Redis 7 ────────────────────────────────────────────────
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Arena Redis cluster',
      subnetIds: props.foundationStack.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }).subnetIds,
    });

    this.redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      engine: 'redis',
      engineVersion: '7.0',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [props.foundationStack.redisSg.securityGroupId],
    });
    this.redisCluster.addDependency(redisSubnetGroup);

    new cdk.CfnOutput(this, 'RedisEndpointAddress', {
      value: this.redisCluster.attrRedisEndpointAddress,
      description: 'ElastiCache Redis endpoint address',
      exportName: 'ArenaRedisEndpointAddress',
    });

    new cdk.CfnOutput(this, 'RedisEndpointPort', {
      value: this.redisCluster.attrRedisEndpointPort,
      description: 'ElastiCache Redis port',
      exportName: 'ArenaRedisEndpointPort',
    });
  }
}
