# 1BRC for traP

This repository contains a full contest platform for benchmarking implementations of the
One Billion Rows Challenge over generated traQ-like message data.

## Contest platform

The application is a pnpm workspace:

- `apps/web`: React, Vite, Tailwind CSS 4 and daisyUI 5 frontend.
- `apps/server`: Hono API, MariaDB migrations, R2 presigning, upload handling and benchmark worker.
- `apps/runner`: forced-command SSH gateway and isolated Docker benchmark runner.
- `apps/mock-auth`: local OAuth/header-auth emulator.
- `packages/contracts`: shared Zod schemas and TypeScript contracts.
- `infra/cdk`: TypeScript CDK stack for the dedicated benchmark EC2 instance.
- `infra/ansible`: Ubuntu 26.04/Docker runner provisioning.
- `cmd/contest_data`: local-only Go dataset, expected result, zstd, R2/RustFS and rsync CLI.

The browser-facing site is public. Submission and history routes accept either the trusted
`X-Forwarded-User` injected by the authentication proxy or a per-user `1brc_...` access key.
The Hono container must not be exposed directly in production.

### Required application environment

MariaDB connection settings deliberately use only these names:

```text
NS_MARIADB_DATABASE
NS_MARIADB_HOSTNAME
NS_MARIADB_PASSWORD
NS_MARIADB_PORT
NS_MARIADB_USER
```

The API also needs contest dates, R2 read-only credentials, and runner SSH settings. See
[`compose.yaml`](compose.yaml) and [`.env.example`](.env.example) for the complete development
configuration. Production should use a separate read-only R2 key for the API; the local Go CLI
uses a read/write key. Production private-key SSH also requires the runner's OpenSSH
`SHA256:...` fingerprint in `RUNNER_SSH_HOST_KEY_SHA256`.

## Local development

Node.js 24, Go 1.24, Docker and Docker Compose are required. RustFS is used as the local S3-compatible
object store. The benchmark-host container is privileged because it runs a dedicated Docker daemon;
do not reuse that container definition outside development.

```sh
cp .env.example .env

# Create small deterministic public/private fixtures and Go-only expected results.
go run ./cmd/contest_data generate \
  --contest-id 1brc-trap-local \
  --output data/contest \
  --runner-dir data/local \
  --public-rows 100000 \
  --private-rows 100000 \
  --tiers 1000,10000,100000

docker compose up -d rustfs mariadb benchmark-host

# Upload only from this local operator command; the application never uploads datasets.
go run ./cmd/contest_data upload \
  --manifest data/contest/manifest.json \
  --endpoint http://localhost:9000 \
  --bucket onebrc-datasets \
  --access-key rustfsadmin \
  --secret-key rustfsadmin \
  --create-bucket

docker compose up -d --build

# Log in as the local admin and import the public-object allowlist.
curl -sS -c /tmp/onebrc-cookie -o /dev/null \
  'http://localhost:8080/_oauth/login?redirect=/'
curl --fail-with-body -b /tmp/onebrc-cookie \
  -H 'Origin: http://localhost:8080' \
  -H 'Content-Type: application/json' \
  --data-binary @data/contest/manifest.json \
  http://localhost:8080/api/v1/admin/datasets/import
```

Open <http://localhost:8080>. The RustFS console is available on port 9001. Database migrations run
as a one-shot Compose service before the API and worker start. `rustfs-init` creates a bucket-scoped
GetObject-only API identity; the `rustfsadmin` credentials shown above remain local-operator-only.

### curl submission

Issue an access key from the site, then submit one source file. Native submissions additionally need
an Ubuntu 26.04 x86_64 ELF binary.

```sh
export ONEBRC_ACCESS_KEY='1brc_...'

curl --fail-with-body \
  -H "Authorization: Bearer ${ONEBRC_ACCESS_KEY}" \
  -F executionKind=typescript \
  -F source=@main.ts \
  http://localhost:8080/api/v1/submissions

curl --fail-with-body \
  -H "Authorization: Bearer ${ONEBRC_ACCESS_KEY}" \
  -F executionKind=native \
  -F language=cpp \
  -F binary=@main \
  -F source=@main.cpp \
  http://localhost:8080/api/v1/submissions
```

Programs receive the input filename as their first positional argument and the output filename as
their second. The older baseline utilities documented below retain their historical `-i`/`-o`
interface and are used internally by the Go dataset tool.

## Production benchmark host

Deploy the EC2 instance, copy datasets from the operator machine, build TypeScript artifacts, and run
Ansible:

```sh
pnpm --filter @1brc/cdk synth \
  -c allowedSshCidr=203.0.113.10/32 \
  -c keyPairName=onebrc-admin \
  -c instanceType=r7i.4xlarge

go run ./cmd/contest_data push-runner \
  --source data/local \
  --target ubuntu@BENCHMARK_IP \
  --identity ~/.ssh/onebrc-admin.pem

pnpm --filter @1brc/runner build
ansible-galaxy collection install -r infra/ansible/requirements.yml
ansible-playbook -i infra/ansible/inventory.yml infra/ansible/playbook.yml
```

The CDK stack uses Canonical's Ubuntu 26.04 amd64 SSM parameter, an encrypted gp3 volume, an EIP,
IMDSv2, and an SSH security-group rule restricted to the supplied CIDR. Changing the EC2 type,
runner image, or datasets requires a new `BENCHMARK_ENVIRONMENT_ID` and an empty leaderboard.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
go test ./...
docker compose config --quiet
```

## Benchmark utilities

Utilities and baseline implementations for aggregating generated traQ message data.

Generated CSV rows contain `unix_timestamp,channel_path,message_length,stamp_count`.
Channel paths are generated from short English words with at most five levels, such as `team/dev/api/release/inbox`.
Analyzers aggregate by channel path and month, and emit:

```text
channel_path,YYYY-MM=min_len/mean_len/max_len/messages/stamps
```

## Layout

- `cmd/traq_data/`: generator for synthetic traQ message CSV data.
- `baselines/`: baseline analyzers in Go, C, C++, C#, Ruby, Rust, TypeScript, and Zig.
- `optimized/`: allocation-conscious, parallel analyzers for the same languages. Each
  implementation is contained in one source file and uses no third-party library.
- `data/`: local generated CSV files. These are intentionally ignored by Git.

## Example

```sh
go run ./cmd/traq_data -n 100000 -o data/traq_data.csv
go run ./baselines/go -i data/traq_data.csv -o traq_baseline.out
```

## 100M C++ run

```sh
go run ./cmd/traq_data -n 100000000 -o data/data_100m.csv
g++ -O3 -march=native -std=c++20 -pthread optimized/cpp/main.cpp -o optimized/cpp/traq_optimized_cpp
optimized/cpp/traq_optimized_cpp -i data/data_100m.csv -o data/data_100m_optimized_cpp.out -t 16 --profile
```

## 100M optimized Go run

```sh
go build -o optimized/go/traq_optimized_go ./optimized/go
optimized/go/traq_optimized_go -i data/data_100m.csv -o data/data_100m_optimized_go.out -t 16 --profile
```

## Other optimized implementations

All optimized analyzers keep the baseline `-i`/`-o` interface and additionally
accept `-t`/`--threads` and `--profile`. They require a seekable input path so
native implementations can use `mmap` and managed implementations can split the
file on complete CSV rows.

```sh
gcc -O3 -march=native -std=c17 -pthread optimized/c/main.c -o traq_c
g++ -O3 -march=native -std=c++20 -pthread optimized/cpp/main.cpp -o traq_cpp
rustc -C opt-level=3 -C target-cpu=native -C lto=fat -C codegen-units=1 optimized/rust/main.rs -o traq_rust
zig build-exe optimized/zig/main.zig -O ReleaseFast -mcpu=native -femit-bin=traq_zig

ruby optimized/ruby/main.rb -i data/data_100m.csv -o result.out -t 8 --profile
node --experimental-strip-types optimized/typescript/main.ts -i data/data_100m.csv -o result.out -t 8 --profile
```

The C# source is `optimized/csharp/Program.cs`; compile it in a .NET 8 console
project with `AllowUnsafeBlocks=true` (Native AOT is supported), then use the same
arguments. None of the implementations loads a second full copy of the input
into a language heap. For benchmark data held in RAM, place the CSV on tmpfs.
