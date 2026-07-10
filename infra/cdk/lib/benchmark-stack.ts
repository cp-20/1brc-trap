import {
  CfnOutput,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_iam as iam,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export class BenchmarkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const instanceType =
      (this.node.tryGetContext("instanceType") as string | undefined) ??
      "r7i.4xlarge";
    const allowedSshCidr = this.node.tryGetContext("allowedSshCidr") as
      | string
      | undefined;
    const keyPairName = this.node.tryGetContext("keyPairName") as
      | string
      | undefined;
    const volumeSizeGiB = Number(
      this.node.tryGetContext("volumeSizeGiB") ?? 200,
    );
    if (!allowedSshCidr)
      throw new Error("CDK context allowedSshCidr is required");
    if (!keyPairName) throw new Error("CDK context keyPairName is required");
    if (!Number.isInteger(volumeSizeGiB) || volumeSizeGiB < 100)
      throw new Error("volumeSizeGiB must be at least 100");

    const vpc = new ec2.Vpc(this, "BenchmarkVpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(
      this,
      "BenchmarkSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
        description:
          "Only the 1BRC worker and operator may SSH to the benchmark host",
      },
    );
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(allowedSshCidr),
      ec2.Port.tcp(22),
      "SSH from application egress CIDR",
    );

    const role = new iam.Role(this, "BenchmarkRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });
    const keyPair = ec2.KeyPair.fromKeyPairName(
      this,
      "AdminKeyPair",
      keyPairName,
    );
    const image = ec2.MachineImage.fromSsmParameter(
      "/aws/service/canonical/ubuntu/server/26.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
      { os: ec2.OperatingSystemType.LINUX },
    );
    const instance = new ec2.Instance(this, "BenchmarkInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup,
      role,
      keyPair,
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: image,
      requireImdsv2: true,
      detailedMonitoring: true,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(volumeSizeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    instance.userData.addCommands(
      "set -eu",
      "install -d -m 0755 /var/lib/1brc/data /var/lib/1brc/jobs",
      "systemctl mask apt-daily.service apt-daily-upgrade.service || true",
    );

    const eip = new ec2.CfnEIP(this, "BenchmarkEip", { domain: "vpc" });
    new ec2.CfnEIPAssociation(this, "BenchmarkEipAssociation", {
      allocationId: eip.attrAllocationId,
      instanceId: instance.instanceId,
    });

    new CfnOutput(this, "BenchmarkPublicIp", { value: eip.ref });
    new CfnOutput(this, "BenchmarkInstanceId", { value: instance.instanceId });
    new CfnOutput(this, "BenchmarkEnvironment", {
      value: `${instanceType}-ubuntu26`,
    });
  }
}
