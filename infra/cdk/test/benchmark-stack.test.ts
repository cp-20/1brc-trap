import { describe, it } from "bun:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

import { BenchmarkStack } from "../lib/benchmark-stack.js";

describe("BenchmarkStack", () => {
  it("uses the Ubuntu 26.04 AMI parameter and restricts SSH", () => {
    const app = new App({
      context: {
        allowedSshCidr: "203.0.113.10/32",
        keyPairName: "test-key",
        instanceType: "r7i.2xlarge",
      },
    });
    const stack = new BenchmarkStack(app, "TestStack");
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: "203.0.113.10/32",
          FromPort: 22,
          ToPort: 22,
          IpProtocol: "tcp",
        }),
      ]),
    });
    template.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "r7i.2xlarge",
      ImageId: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: Match.objectLike({ HttpTokens: "required" }),
      }),
    });
  });

  it("allows SSH from any IPv4 address by default", () => {
    const app = new App({ context: { keyPairName: "test-key" } });
    const stack = new BenchmarkStack(app, "DefaultCidrStack");
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: "0.0.0.0/0", FromPort: 22, ToPort: 22 }),
      ]),
    });
    template.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "r7i.2xlarge",
    });
  });
});
