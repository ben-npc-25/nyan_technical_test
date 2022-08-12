import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const listener = new awsx.elasticloadbalancingv2.NetworkListener("nginx", { port: 80 });
const service = new awsx.ecs.FargateService("nginx", {
    desiredCount: 3,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: awsx.ecs.Image.fromPath("nginx", "./web"),
                memory: 512,
                portMappings: [listener],
            },
        },  
    },
});

const connect = new aws.codestarconnections.Connection("connect", {providerType: "GitHub"});
const codepipelineBucket = new aws.s3.BucketV2("codepipelineBucket", {});
const aws_vpc = new aws.ec2.DefaultVpc("default-vpc");
const aws_subnet = new aws.ec2.DefaultSubnet("default_az1", {
  availabilityZone: "eu-west-2a",
});
const lb = new aws.ec2.Eip("lb", {
  vpc: true,
});
const aws_nat = new aws.ec2.NatGateway("nat", {
  allocationId: lb.id,
  subnetId: aws_subnet.id,
}); 
const aws_security_group = new aws.ec2.DefaultSecurityGroup("default", {
  vpcId: aws_vpc.id,
  ingress: [{
    protocol: "-1",
    self: true,
    fromPort: 0,
    toPort: 0,
}],
egress: [{
    fromPort: 0,
    toPort: 0,
    protocol: "-1",
    cidrBlocks: ["0.0.0.0/0"],
}],
});

const buildRole = new aws.iam.Role("buildRole", {assumeRolePolicy: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
`});
const buildRolePolicy = new aws.iam.RolePolicy("buildRolePolicy", {
    role: buildRole.name,
    policy: pulumi.interpolate`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Resource": [
        "*"
      ],
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:*"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:*"
      ],
      "Resource": [
        "${codepipelineBucket.arn}",
        "${codepipelineBucket.arn}/*"
      ]
    }
  ]
}
`,
});
//codebuild
const buildProject = new aws.codebuild.Project("buildProject", {
    description: "test_codebuild_project",
    buildTimeout: 5,
    serviceRole: buildRole.arn,
    artifacts: {
        type: "NO_ARTIFACTS",
    },
    cache: {
        type: "S3",
        location: codepipelineBucket.bucket,
    },
    environment: {
        computeType: "BUILD_GENERAL1_SMALL",
        image: "aws/codebuild/standard:1.0",
        type: "LINUX_CONTAINER",
        imagePullCredentialsType: "CODEBUILD",
        environmentVariables: [
          {
              name: "PULUMI_ACCESS_TOKEN",
              value: "pul-13c90dea9ce3f6a2d2fa409e7a1f9e65edcbcc10",
              type: "SECRETS_MANAGER"
          },
      ],
    },
    logsConfig: {
        cloudwatchLogs: {
            groupName: "log-group",
            streamName: "log-stream",
        },
        s3Logs: {
            status: "ENABLED",
            location: pulumi.interpolate`${codepipelineBucket.id}/build-log`,
        },
    },
    source: {
        type: "GITHUB",
        location: "https://github.com/ben-npc-25/nyan_technical_test.git",
        gitCloneDepth: 1,
        gitSubmodulesConfig: {
            fetchSubmodules: true,
        },
    },
    sourceVersion: "master",
    vpcConfig: {
        vpcId: aws_vpc.id,
        subnets: [
            aws_subnet.id
        ],
        securityGroupIds: [
            aws_security_group.id,
        ],
    },
    tags: {
        Environment: "buildProject",
    },
});

//codepipeline
const codepipelineRole = new aws.iam.Role("codepipelineRole", {assumeRolePolicy: `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codepipeline.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
`});
// const s3kmskey = aws.kms.getAlias({
//     name: "alias/myKmsKey",
// });
const codepipeline = new aws.codepipeline.Pipeline("codepipeline", {
    roleArn: codepipelineRole.arn,
    artifactStores: [{
        location: codepipelineBucket.bucket,
        type: "S3",
        // encryptionKey: {
        //     id: s3kmskey.then(s3kmskey => s3kmskey.arn),
        //     type: "KMS",
        // },
    }],
    stages: [
        {
            name: "Source",
            actions: [{
                name: "Source",
                category: "Source",
                owner: "AWS",
                provider: "CodeStarSourceConnection",
                version: "1",
                outputArtifacts: ["source_output"],
                configuration: {
                    ConnectionArn: connect.arn,
                    FullRepositoryId: "ben-npc-25/nyan_technical_test",
                    BranchName: "master",
                },
            }],
        },
        {
            name: "Build",
            actions: [{
                name: "Build",
                category: "Build",
                owner: "AWS",
                provider: "CodeBuild",
                inputArtifacts: ["source_output"],
                outputArtifacts: ["build_output"],
                version: "1",
                configuration: {
                    ProjectName: buildProject.id,
                },
            }],
        },
        {
            name: "Deploy",
            actions: [{
                name: "Deploy",
                category: "Deploy",
                owner: "AWS",
                provider: "CloudFormation",
                inputArtifacts: ["build_output"],
                version: "1",
                configuration: {
                    ActionMode: "REPLACE_ON_FAILURE",
                    Capabilities: "CAPABILITY_AUTO_EXPAND,CAPABILITY_IAM",
                    OutputFileName: "CreateStackOutput.json",
                    StackName: "MyStack",
                    TemplatePath: "build_output::sam-templated.yaml",
                },
            }],
        },
    ],
});
const codepipelineBucketAcl = new aws.s3.BucketAclV2("codepipelineBucketAcl", {
    bucket: codepipelineBucket.id,
    acl: "private",
});
const codepipelinePolicy = new aws.iam.RolePolicy("codepipelinePolicy", {
    role: codepipelineRole.id,
    policy: pulumi.interpolate`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect":"Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetBucketVersioning",
        "s3:PutObjectAcl",
        "s3:PutObject"
      ],
      "Resource": [
        "${codepipelineBucket.arn}",
        "${codepipelineBucket.arn}/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "codestar-connections:UseConnection",
        "codedeploy:*"
      ],
      "Resource": "${connect.arn}"
    },
    {
      "Effect": "Allow",
      "Action": [
        "codebuild:BatchGetBuilds",
        "codebuild:StartBuild",
        "codedeploy:*"
      ],
      "Resource": "*"
    }
  ]
}
`,
});

export let frontendURL = pulumi.interpolate `http://${listener.endpoint.hostname}/`;