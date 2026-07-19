import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { MariaDbContainer } from "@testcontainers/mariadb";
import { eq } from "drizzle-orm";

import type { Config } from "../infrastructures/config.js";
import { createDatabase, type Database } from "../infrastructures/database.js";
import { migrateDatabase } from "../infrastructures/migrations.js";
import {
  adminAudit,
  apiTokens,
  benchmarkRuns,
  contestState,
  datasetReleases,
  submissionSources,
  submissions,
  users,
} from "../infrastructures/schema.js";
import { createAdminRepository } from "./admin-repository.js";
import { createContestRepository } from "./contest-repository.js";
import { createSubmissionRepository } from "./submission-repository.js";

const mariadbImage =
  "mariadb:11.8.8@sha256:efb4959ef2c835cd735dbc388eb9ad6aab0c78dd64febcd51bc17481111890c4";

let container: Awaited<ReturnType<MariaDbContainer["start"]>>;
let config: Config;
let database: Database;

beforeAll(async () => {
  container = await new MariaDbContainer(mariadbImage)
    .withDatabase("onebrc_test")
    .withUsername("onebrc")
    .withUserPassword("onebrc")
    .start();
  config = {
    NS_MARIADB_HOSTNAME: container.getHost(),
    NS_MARIADB_PORT: container.getPort(),
    NS_MARIADB_USER: container.getUsername(),
    NS_MARIADB_PASSWORD: container.getUserPassword(),
    NS_MARIADB_DATABASE: container.getDatabase(),
  } as Config;
  await migrateDatabase(config);
  database = createDatabase(config);
}, 120_000);

afterAll(async () => {
  await database?.close();
  await container?.stop();
});

beforeEach(async () => {
  await database.orm.delete(benchmarkRuns);
  await database.orm.delete(submissionSources);
  await database.orm.delete(adminAudit);
  await database.orm.delete(datasetReleases);
  await database.orm.delete(apiTokens);
  await database.orm.delete(submissions);
  await database.orm.delete(users);
  await database.orm.update(contestState).set({
    private_published_at: null,
    worker_heartbeat_at: null,
    benchmark_environment_id: null,
  });
});

describe("Drizzle migrations", () => {
  it("空のMariaDBへschemaとsingletonを作成し、再適用しても状態を壊さない", async () => {
    await migrateDatabase(config);

    const states = await database.orm.select().from(contestState);
    expect(states).toHaveLength(1);
    expect(states[0]?.singleton_id).toBe(1);
  });
});

describe("submission reservation", () => {
  it("同じユーザーの並行予約をDB lockで直列化し、activeな提出を1件に保つ", async () => {
    const repository = createSubmissionRepository(database);
    const contest = openContest();

    const results = await Promise.all([
      repository.reserve("user", contest),
      repository.reserve("user", contest),
    ]);

    expect(results.filter((result) => result.isOk())).toHaveLength(1);
    expect(results.find((result) => result.isErr())?.error.code).toBe(
      "active_submission",
    );
    expect(await database.orm.select().from(submissions)).toHaveLength(1);
  });

  it("終了後も提出を予約できる", async () => {
    const repository = createSubmissionRepository(database);
    const contest = {
      ...openContest(),
      CONTEST_END_AT: new Date(Date.now() - 1_000),
    };

    const result = await repository.reserve("user", contest);

    expect(result.isOk()).toBe(true);
    expect(await database.orm.select().from(submissions)).toHaveLength(1);
    expect(await database.orm.select().from(users)).toHaveLength(1);
  });

  it("再起動時にuploadingを回収し、runningを失敗扱いにする", async () => {
    await database.orm.insert(users).values({ username: "user" });
    await database.orm.insert(submissions).values([
      {
        id: "0198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "user",
        status: "uploading",
        upload_started_at: new Date(),
      },
      {
        id: "1198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "user",
        status: "queued",
        upload_started_at: new Date(),
      },
      {
        id: "2198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "user",
        status: "running",
        upload_started_at: new Date(),
      },
    ]);

    const uploads =
      await createSubmissionRepository(database).discardInterruptedUploads();
    const repository = createSubmissionRepository(database);
    const runs = await repository.interruptedRuns();
    const failed = await repository.failInterruptedRuns();

    expect(uploads._unsafeUnwrap()).toEqual([
      "0198d9ec-9024-4d69-8bb8-9c13a73f6768",
    ]);
    expect(runs._unsafeUnwrap()).toEqual([
      { id: "2198d9ec-9024-4d69-8bb8-9c13a73f6768" },
    ]);
    expect(failed.isOk()).toBe(true);
    expect(
      (await database.orm.select().from(submissions)).map(
        ({ status }) => status,
      ),
    ).toEqual(["queued", "infrastructure_error"]);
  });
});

describe("submission history", () => {
  it("提出番号と待ち人数を取得する", async () => {
    await database.orm.insert(users).values({ username: "user" });
    await database.orm.insert(submissions).values([
      {
        id: "0198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "user",
        status: "running",
        upload_started_at: new Date("2026-07-17T00:00:00Z"),
      },
      {
        id: "1198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "user",
        status: "queued",
        upload_started_at: new Date("2026-07-17T00:01:00Z"),
      },
    ]);

    const result = await createSubmissionRepository(database).byUser("user");

    expect(result.isOk()).toBe(true);
    expect<Array<{ submission_number: number; queue_ahead: number | null }>>(
      result._unsafeUnwrap().map(({ submission_number, queue_ahead }) => ({
        submission_number,
        queue_ahead,
      })),
    ).toEqual([
      { submission_number: 2, queue_ahead: 1 },
      { submission_number: 1, queue_ahead: null },
    ]);
  });
});

describe("leaderboard submissions", () => {
  it("終了後の提出を除外し、順位推移ではエラーを飛ばす", async () => {
    const contestEndAt = new Date("2026-07-17T00:00:00Z");
    await database.orm
      .insert(users)
      .values([
        { username: "before" },
        { username: "error" },
        { username: "after" },
      ]);
    await database.orm.insert(submissions).values([
      {
        id: "0198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "before",
        status: "completed",
        execution_kind: "native",
        language: "c",
        public_verdict: "accepted",
        public_score_ns: "2",
        upload_started_at: contestEndAt,
      },
      {
        id: "2198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "error",
        status: "completed",
        execution_kind: "native",
        language: "c",
        public_verdict: "runtime_error",
        upload_started_at: new Date(contestEndAt.getTime() - 1),
      },
      {
        id: "1198d9ec-9024-4d69-8bb8-9c13a73f6768",
        username: "after",
        status: "completed",
        execution_kind: "native",
        language: "c",
        public_verdict: "accepted",
        public_score_ns: "1",
        upload_started_at: new Date(contestEndAt.getTime() + 1),
      },
    ]);
    await database.orm
      .update(users)
      .set({
        representative_submission_id: "0198d9ec-9024-4d69-8bb8-9c13a73f6768",
      })
      .where(eq(users.username, "before"));
    await database.orm
      .update(users)
      .set({
        representative_submission_id: "1198d9ec-9024-4d69-8bb8-9c13a73f6768",
      })
      .where(eq(users.username, "after"));
    const repository = createContestRepository(database);

    const leaderboard = await repository.leaderboard(undefined, contestEndAt);
    const replay = await repository.leaderboardReplay(contestEndAt);

    expect(leaderboard._unsafeUnwrap().map(({ username }) => username)).toEqual(
      ["before"],
    );
    expect(replay._unsafeUnwrap().map(({ username }) => username)).toEqual([
      "before",
    ]);
  });
});

describe("private result publication", () => {
  it("publish/unpublishは公開状態だけを変更し、提出ソースを保持する", async () => {
    await completedSubmission("user", "0198d9ec-9024-4d69-8bb8-9c13a73f6768");
    const repository = createAdminRepository(database);

    const published = await repository.publishPrivateResults(
      new Date(Date.now() - 1_000),
    );
    const unpublished = await repository.unpublishPrivateResults();

    expect(published.isOk()).toBe(true);
    expect(unpublished.isOk()).toBe(true);
    expect(await database.orm.select().from(submissionSources)).toHaveLength(1);
    const [state] = await database.orm.select().from(contestState);
    expect(state?.private_published_at).toBeNull();
  });

  it("未完了の提出がある間は公開状態を変更しない", async () => {
    await database.orm.insert(users).values({ username: "user" });
    await database.orm.insert(submissions).values({
      id: "1198d9ec-9024-4d69-8bb8-9c13a73f6768",
      username: "user",
      status: "queued",
      upload_started_at: new Date(),
    });
    const repository = createAdminRepository(database);

    const result = await repository.publishPrivateResults(
      new Date(Date.now() - 1_000),
    );

    expect(result.isErr() && result.error.code).toBe("queue_not_drained");
    const [state] = await database.orm.select().from(contestState);
    expect(state?.private_published_at).toBeNull();
  });

  it("計測エラーで終了した提出があっても公開できる", async () => {
    await database.orm.insert(users).values({ username: "user" });
    await database.orm.insert(submissions).values({
      id: "2198d9ec-9024-4d69-8bb8-9c13a73f6768",
      username: "user",
      status: "infrastructure_error",
      infrastructure_error: "benchmark host unavailable",
      upload_started_at: new Date(),
    });

    const result = await createAdminRepository(database).publishPrivateResults(
      new Date(Date.now() - 1_000),
    );

    expect(result.isOk()).toBe(true);
    const [state] = await database.orm.select().from(contestState);
    expect(state?.private_published_at).not.toBeNull();
  });
});

function openContest(): Config {
  return {
    ...config,
    CONTEST_START_AT: new Date(Date.now() - 60_000),
    CONTEST_END_AT: new Date(Date.now() + 60_000),
  };
}

async function completedSubmission(username: string, id: string) {
  await database.orm.insert(users).values({ username });
  await database.orm.insert(submissions).values({
    id,
    username,
    status: "completed",
    upload_started_at: new Date(),
  });
  await database.orm.insert(submissionSources).values({
    submission_id: id,
    filename: "main.ts",
    sha256: "a".repeat(64),
    content: Buffer.from("console.log('hello')"),
  });
}
