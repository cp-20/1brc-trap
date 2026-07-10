import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().url().default("http://localhost:8080"),
  STATIC_ROOT: z.string().default("../web/dist"),
  CONTEST_ID: z.string().min(1).default("1brc-trap-2026"),
  CONTEST_START_AT: z.coerce.date(),
  CONTEST_END_AT: z.coerce.date(),
  ADMIN_USERS: z.string().default(""),
  TRUST_PROXY_HEADER: z.enum(["true", "false"]).default("true"),
  NS_MARIADB_DATABASE: z.string().min(1),
  NS_MARIADB_HOSTNAME: z.string().min(1),
  NS_MARIADB_PASSWORD: z.string(),
  NS_MARIADB_PORT: z.coerce.number().int().positive(),
  NS_MARIADB_USER: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_ENDPOINT: z.string().url().optional(),
  RUNNER_SSH_HOST: z.string().min(1),
  RUNNER_SSH_PORT: z.coerce.number().int().positive().default(22),
  RUNNER_SSH_USER: z.string().min(1).default("onebrc"),
  RUNNER_SSH_PRIVATE_KEY_PATH: z.string().optional(),
  RUNNER_SSH_PASSWORD: z.string().optional(),
  RUNNER_SSH_HOST_KEY_SHA256: z
    .string()
    .regex(/^(?:SHA256:)?[A-Za-z0-9+/]+={0,2}$/)
    .optional(),
  BENCHMARK_ENVIRONMENT_ID: z.string().min(1),
  BENCHMARK_INSTANCE_TYPE: z.string().default("r7i.4xlarge"),
  BENCHMARK_CPU: z.string().default("16 vCPU"),
  BENCHMARK_MEMORY: z.string().default("128 GiB"),
  BENCHMARK_RUNNER_IMAGE: z.string().min(1),
  BENCHMARK_KERNEL: z.string().default("Ubuntu 26.04 standard kernel"),
  BENCHMARK_DOCKER_VERSION: z.string().default("29.x"),
  BENCHMARK_NODE_VERSION: z.string().default("24.18.0"),
  BENCHMARK_RUBY_VERSION: z.string().default("4.0.5"),
  BENCHMARK_SHARED_LIBRARIES: z
    .string()
    .default(
      "libc6,libgcc-s1,libstdc++6,zlib1g,libssl3t64,libyaml-0-2,libreadline8t64,libffi8,libgdbm6t64",
    ),
  DEV_AUTH_ENABLED: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  if (parsed.CONTEST_START_AT >= parsed.CONTEST_END_AT) {
    throw new Error("CONTEST_START_AT must be earlier than CONTEST_END_AT");
  }
  if (!parsed.RUNNER_SSH_PRIVATE_KEY_PATH && !parsed.RUNNER_SSH_PASSWORD) {
    throw new Error(
      "RUNNER_SSH_PRIVATE_KEY_PATH or RUNNER_SSH_PASSWORD is required",
    );
  }
  if (
    parsed.NODE_ENV === "production" &&
    parsed.RUNNER_SSH_PRIVATE_KEY_PATH &&
    !parsed.RUNNER_SSH_HOST_KEY_SHA256
  ) {
    throw new Error(
      "RUNNER_SSH_HOST_KEY_SHA256 is required with a production SSH private key",
    );
  }
  return {
    ...parsed,
    admins: new Set(
      parsed.ADMIN_USERS.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    trustProxyHeader: parsed.TRUST_PROXY_HEADER === "true",
    devAuthEnabled: parsed.DEV_AUTH_ENABLED === "true",
  };
}
