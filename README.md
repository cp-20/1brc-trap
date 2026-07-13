# 1BRC for traP

1BRC形式の最適化コンテストを運営するためのWebアプリケーションです。React製フロントエンド、Hono API、非同期worker、隔離された計測runner、データ生成・配布ツール、AWS CDKとAnsibleを含みます。

## Quick start

必要なもの:

- [mise](https://mise.jdx.dev/)
- Docker / Docker Compose
- x86_64 Linuxコンテナを実行できる環境

次のスクリプトがツールの導入、fixture生成、依存サービスの起動、migration、manifest取込みまで行います。

```sh
./scripts/setup-local.sh
```

初回はUbuntu 26.04ベースの計測imageをbuildするため数分かかります。起動後は <http://localhost:8080> を開きます。開発用ユーザーは `cp20` です。

```sh
docker compose ps
docker compose logs -f api worker benchmark-host
docker compose down
```

DB・object storage・runner artifactを含めて初期化する場合だけ `docker compose down -v` を使います。

## 開発

miseが有効なshellでは `mise exec --` を省略できます。

```sh
mise exec -- bun install --frozen-lockfile
mise exec -- bun run dev
mise exec -- bun run typecheck
mise exec -- bun run test
mise exec -- bun run build
mise exec -- go test ./...
docker compose config --quiet
```

コンテナ構成のまま開発する場合は、変更したworkspaceに対応するserviceだけを自動でbuild・再作成します。

```sh
docker compose watch
```

概要・リーダーボード・実行キューのリアルタイム表示を確認する場合は、ローカル環境の提出APIへ5ユーザー分のTypeScript baselineを同時に送ります。

```sh
./scripts/enqueue-demo-submissions.sh
```

主要なディレクトリ:

- `apps/web`: React / Viteフロントエンド
- `apps/server`: Hono API、worker、migration
- `apps/runner`: forced-command SSH gatewayとDocker計測処理
- `apps/mock-auth`: ローカル用認証proxy
- `packages/contracts`: Hono RPCとZodの共有contract
- `cmd/contest_data`: データ生成、object storageへのupload、runnerへの転送
- `infra/cdk`: 計測用EC2
- `infra/ansible`: 計測ホストの構成

依存関係はBun workspaceで管理し、lockfileは `bun.lock` です。Actionの参照を更新するときは `mise exec -- pinact run` を実行します。

## デプロイ

本番には、アプリケーションとは別に次の周辺環境が必要です。

1. MariaDB 11.4
2. S3互換object storage (Cloudflare R2を想定)
3. Ubuntu 26.04 x86_64の専用計測ホスト
4. `X-Forwarded-User` を設定する認証proxy
5. API/workerから計測ホストへ到達できるSSH経路

### 1. 計測ホストを作る

CDKはUbuntu 26.04 amd64、暗号化gp3、EIP、接続元を限定したSSH ruleを作成します。

```sh
mise exec -- bun run --filter @1brc/cdk synth \
  -c allowedSshCidr=203.0.113.10/32 \
  -c keyPairName=onebrc-admin \
  -c instanceType=r7i.4xlarge

mise exec -- bun run --filter @1brc/cdk deploy \
  -c allowedSshCidr=203.0.113.10/32 \
  -c keyPairName=onebrc-admin \
  -c instanceType=r7i.4xlarge
```

`infra/ansible/inventory.example.yml` と `infra/ansible/group_vars/all.example.yml` をコピーして、接続先、runner公開鍵、データのSHA-256を設定します。

```sh
ansible-galaxy collection install -r infra/ansible/requirements.yml
ansible-playbook -i infra/ansible/inventory.yml infra/ansible/playbook.yml
```

### 2. データを配置する

`contest_data` で入力、期待出力、manifestを生成します。非公開データを含む `data/` はGit管理外です。

```sh
mise exec -- go run ./cmd/contest_data generate \
  --contest-id 1brc-trap-2026 \
  --output data/contest \
  --runner-dir data/runner \
  --public-rows 1000000000 \
  --private-rows 1000000000 \
  --tiers 1000000,10000000,100000000 \
  --revision "$(git rev-parse HEAD)"

mise exec -- go run ./cmd/contest_data upload \
  --manifest data/contest/manifest.json \
  --bucket onebrc-datasets \
  --account-id "$R2_ACCOUNT_ID" \
  --access-key "$AWS_ACCESS_KEY_ID" \
  --secret-key "$AWS_SECRET_ACCESS_KEY"

mise exec -- go run ./cmd/contest_data push-runner \
  --source data/runner \
  --target ubuntu@BENCHMARK_IP \
  --identity ~/.ssh/onebrc-admin.pem
```

本番のobject storage用credentialは、APIには対象bucketの `GetObject` だけを許可し、データ投入用credentialとは分離してください。

### 3. APIとworkerを起動する

`infra/docker/app.Dockerfile` から同じimageをbuildし、API、worker、migrationを別processとして起動します。

```sh
docker build -f infra/docker/app.Dockerfile -t onebrc-app .

docker run --rm --env-file .env.production onebrc-app \
  /opt/bun/bin/bun /app/apps/server/dist/migrate.js
docker run --env-file .env.production onebrc-app \
  /opt/bun/bin/bun /app/apps/server/dist/index.js
docker run --env-file .env.production onebrc-app \
  /opt/bun/bin/bun /app/apps/server/dist/worker.js
```

起動後、`data/contest/manifest.json` を運営管理画面または認証済みの `POST /api/v1/admin/datasets/import` から取り込みます。manifestに含まれないobjectには、APIからpresigned URLを発行できません。

APIを直接インターネットへ公開せず、認証proxyから渡される `X-Forwarded-User` だけを信頼する構成にします。SSEを中継するため、proxyでは `/api/v1/submissions/events` と `/api/v1/contest/events` のbufferingを無効にしてください。

### 環境変数

必須値は `apps/server/src/infrastructures/config.ts` が検証します。主な設定は次のとおりです。

| 分類       | 変数                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| アプリ     | `APP_ORIGIN`, `CONTEST_ID`, `CONTEST_START_AT`, `CONTEST_END_AT`, `ADMIN_USERS`                                      |
| MariaDB    | `NS_MARIADB_HOSTNAME`, `NS_MARIADB_PORT`, `NS_MARIADB_DATABASE`, `NS_MARIADB_USER`, `NS_MARIADB_PASSWORD`            |
| R2/S3      | `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`                         |
| runner SSH | `RUNNER_SSH_HOST`, `RUNNER_SSH_PORT`, `RUNNER_SSH_USER`, `RUNNER_SSH_PRIVATE_KEY_PATH`, `RUNNER_SSH_HOST_KEY_SHA256` |
| 計測環境   | `BENCHMARK_ENVIRONMENT_ID`, `BENCHMARK_INSTANCE_TYPE`, `BENCHMARK_RUNNER_IMAGE`                                      |

本番で秘密鍵認証を使う場合、`RUNNER_SSH_HOST_KEY_SHA256` は必須です。計測ホスト、runner image、データセット、計測条件のいずれかを変えた場合は `BENCHMARK_ENVIRONMENT_ID` も変更し、異なる環境のスコアを混在させないでください。

ローカル用の値は [.env.example](./.env.example) と [compose.yaml](./compose.yaml)、runner側の値は [runner.env.j2](./infra/ansible/templates/runner.env.j2) を参照してください。
