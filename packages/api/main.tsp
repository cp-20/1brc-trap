import "@typespec/http";
import "@typespec/openapi3";

using TypeSpec.Http;

@service(#{ title: "1BRC for traP API" })
@route("/api/v1")
namespace OneBrcApi;

enum ExecutionKind {
  native,
  javascript,
  typescript,
  bun,
  ruby,
}

enum Language {
  c,
  cpp,
  go,
  rust,
  zig,
  csharp,
  other,
  javascript,
  typescript,
  bun,
  ruby,
}

enum SubmissionStatus {
  uploading,
  queued,
  running,
  completed,
  rejected,
  infrastructure_error,
  disqualified,
}

enum Verdict {
  accepted,
  wrong_answer,
  runtime_error,
  time_limit,
  output_limit,
  invalid_submission,
  infrastructure_error,
  disqualified,
}

enum LeaderboardBoard {
  public,
  private,
}

enum DatasetKind {
  input,
  expected,
}

scalar Uuid extends string;
@pattern("^\\d+$")
scalar Nanoseconds extends string;
scalar DateTimeString extends string;

model ErrorDetail {
  code: string;
  message: string;
  requestId: string;
}

@error
model ApiErrorResponse {
  @statusCode statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  @body body: {
    error: ErrorDetail;
  };
}

model OkResponse {
  ok: boolean;
}

model AuthUser {
  username: string;
  isAdmin: boolean;
  method: "header" | "token";
}

model MeResponse {
  user: AuthUser | null;
}

model AccessKeyResponse {
  accessKey: string;
  prefix: string;
}

model BenchmarkEnvironment {
  id: string;
  instanceType: string;
  cpu: string;
  memory: string;
  os: string;
  kernel: string;
  docker: string;
  runnerImage: string;
  node: string;
  bun: string;
  ruby: string;
  sharedLibraries: string[];
  repetitions: int32;
  slowFirstAttemptSeconds: int32;
  timeoutSeconds: int32;
  pidLimit: int32;
  stdioLimitBytes: int32;
  outputLimitBytes: int32;
}

model ContestOverview {
  id: string;
  name: string;
  startAt: DateTimeString;
  endAt: DateTimeString;
  privatePublishedAt: DateTimeString | null;
  participants: int32;
  totalSubmissions: int32;
  environment: BenchmarkEnvironment;
}

model LeaderboardEntry {
  rank: int32 | null;
  rankChange: int32 | null;
  username: string;
  submissionId: Uuid;
  language: Language;
  scoreNs: Nanoseconds | null;
  verdict: Verdict;
  submittedAt: DateTimeString;
  sourceAvailable: boolean;
}

model Leaderboard {
  board: LeaderboardBoard;
  privatePublished: boolean;
  ranked: LeaderboardEntry[];
  disqualified: LeaderboardEntry[];
}

model ContestLiveUpdate {
  contest: {
    privatePublishedAt: DateTimeString | null;
    participants: int32;
    totalSubmissions: int32;
  };
  leaderboard: Leaderboard;
}

model LeaderboardReplaySubmission {
  submissionId: Uuid;
  username: string;
  language: Language | null;
  publicVerdict: Verdict | null;
  privateVerdict: Verdict | null;
  privateScoreNs: Nanoseconds | null;
  disqualified: boolean;
  submittedAt: DateTimeString;
}

model LeaderboardReplayResponse {
  submissions: LeaderboardReplaySubmission[];
}

model PublicDataset {
  id: string;
  kind: DatasetKind;
  label: string;
  rows: string;
  compressedBytes: string;
  uncompressedBytes: string;
  compressedSha256: string;
  uncompressedSha256: string;
  downloadUrl: string;
}

model DatasetsResponse {
  datasets: PublicDataset[];
}

model BenchmarkOutcome {
  verdict: Verdict;
  scoreNs: Nanoseconds | null;
  error: string | null;
}

model Submission {
  id: Uuid;
  username: string;
  executionKind: ExecutionKind | null;
  language: Language | null;
  sourceFilename: string | null;
  artifactSha256: string | null;
  status: SubmissionStatus;
  public: BenchmarkOutcome | null;
  private?: BenchmarkOutcome | null;
  infrastructureError: string | null;
  disqualifiedReason: string | null;
  uploadStartedAt: DateTimeString;
  queuedAt: DateTimeString | null;
  startedAt: DateTimeString | null;
  completedAt: DateTimeString | null;
  queueAhead: int32 | null;
  submissionNumber: int32 | null;
}

model SubmissionsResponse {
  submissions: Submission[];
}

model SubmissionResponse {
  submission: Submission;
}

model SubmissionAccepted {
  id: Uuid;
  status: "queued";
  statusUrl: string;
  uploadStartedAt: DateTimeString;
}

model DatasetArtifact {
  @pattern("^[a-z0-9][a-z0-9-]{0,63}$")
  id: string;
  kind: DatasetKind;
  @minLength(1)
  @maxLength(128)
  label: string;
  @pattern("^[\\u0020-\\u007E]+$")
  @maxLength(1024)
  objectKey: string;
  @minValue(1)
  rows: int64;
  @minValue(1)
  compressedBytes: int64;
  @minValue(1)
  uncompressedBytes: int64;
  @pattern("^[a-f0-9]{64}$")
  compressedSha256: string;
  @pattern("^[a-f0-9]{64}$")
  uncompressedSha256: string;
  isPublic: boolean;
}

model DatasetManifest {
  schemaVersion: 1;
  @pattern("^[a-z0-9][a-z0-9-]{0,127}$")
  contestId: string;
  generatedAt: DateTimeString;
  @minLength(1)
  @maxLength(128)
  generatorRevision: string;
  @minItems(4)
  artifacts: DatasetArtifact[];
}

model SubmissionUpload {
  executionKind: HttpPart<ExecutionKind>;
  language?: HttpPart<Language>;
  source: HttpPart<File>;
  binary?: HttpPart<File>;
}

model SseResponse {
  @statusCode statusCode: 200;
  @header contentType: "text/event-stream";
  @body body: string;
}

model RedirectResponse {
  @statusCode statusCode: 302;
  @header location: string;
}

model SourceResponse {
  @statusCode statusCode: 200;
  @header contentType: "text/plain; charset=utf-8";
  @header contentDisposition: string;
  @body body: string;
}

@route("/healthz") @get op getHealth(): OkResponse;
@route("/readyz") @get op getReady(): OkResponse | {@statusCode statusCode: 503; @body body: OkResponse};
@route("/me") @get op getMe(): MeResponse | ApiErrorResponse;
@route("/access-key") @post op issueAccessKey(): {@statusCode statusCode: 201; @body body: AccessKeyResponse} | ApiErrorResponse;
@route("/access-key") @delete op revokeAccessKey(): {@statusCode statusCode: 204} | ApiErrorResponse;
@route("/contest") @get op getContest(): ContestOverview | ApiErrorResponse;
@route("/contest/events") @get op streamContest(@query board?: LeaderboardBoard, @query language?: Language): SseResponse | ApiErrorResponse;
@route("/leaderboard") @get op getLeaderboard(@query board?: LeaderboardBoard, @query language?: Language): Leaderboard | ApiErrorResponse;
@route("/leaderboard/replay") @get op getLeaderboardReplay(): LeaderboardReplayResponse | ApiErrorResponse;
@route("/datasets") @get op getDatasets(): DatasetsResponse | ApiErrorResponse;
@route("/datasets/{datasetId}/{artifact}/download") @get op downloadDataset(@path datasetId: string, @path artifact: DatasetKind): RedirectResponse | ApiErrorResponse;
@route("/submissions") @post op createSubmission(@multipartBody body: SubmissionUpload): {@statusCode statusCode: 202; @header location: string; @body body: SubmissionAccepted} | ApiErrorResponse;
@route("/submissions") @get op listSubmissions(): SubmissionsResponse | ApiErrorResponse;
@route("/submissions/events") @get op streamSubmissions(): SseResponse | ApiErrorResponse;
@route("/submissions/{id}") @get op getSubmission(@path id: Uuid): SubmissionResponse | ApiErrorResponse;
@route("/submissions/{id}/source") @get op getSubmissionSource(@path id: Uuid): SourceResponse | ApiErrorResponse;
@route("/admin/submissions") @get op listAdminSubmissions(): SubmissionsResponse | ApiErrorResponse;
@route("/admin/submissions/{id}/retry") @post op retrySubmission(@path id: Uuid): OkResponse | ApiErrorResponse;
@route("/admin/submissions/{id}/disqualify") @post op disqualifySubmission(@path id: Uuid, @body body: {@minLength(1) reason: string}): OkResponse | ApiErrorResponse;
@route("/admin/datasets/import") @post op importDatasets(@body body: DatasetManifest): {imported: int32} | ApiErrorResponse;
@route("/admin/private/publish") @post op publishPrivate(): {published: true} | ApiErrorResponse;
@route("/admin/private/unpublish") @post op unpublishPrivate(): {published: false} | ApiErrorResponse;
