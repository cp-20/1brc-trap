#!/usr/bin/env node
import { App } from "aws-cdk-lib";

import { BenchmarkStack } from "../lib/benchmark-stack.js";

const app = new App();
const account =
  process.env.CDK_DEFAULT_ACCOUNT ?? app.node.tryGetContext("account");
const region =
  process.env.CDK_DEFAULT_REGION ?? app.node.tryGetContext("region");

new BenchmarkStack(app, "OneBrcBenchmarkStack", {
  env: account && region ? { account, region } : undefined,
});
