# 1BRC for traP

1BRC形式の最適化コンテストを運営するWebアプリケーションです。
React製フロントエンド、Hono API、非同期worker、隔離された計測runner、データ生成ツール、AWS CDK、Terraform、Ansibleを含みます。

## Quick start

ローカル開発には次のソフトウェアが必要です。

- [mise](https://mise.jdx.dev/)
- DockerとDocker Compose
- x86_64 Linuxコンテナを実行できる環境

セットアップスクリプトは開発ツールと依存パッケージを導入し、fixtureを生成して全サービスを起動します。
APIの起動時にMariaDBのmigrationを適用し、生成したmanifestも取り込みます。

```sh
./scripts/setup-local.sh
```

起動後は <http://localhost:8080> を開きます。
開発用ユーザーは `cp20` です。

```sh
docker compose ps
docker compose logs -f api benchmark-host
docker compose down
```

DB、object storage、runner artifactも消す場合だけ `docker compose down -v` を使います。

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

コンテナ構成で開発するときは、Compose Watchが変更されたworkspaceに対応するserviceを再buildします。

```sh
docker compose watch
```

リアルタイム更新を確認するスクリプトは、5ユーザー分のTypeScript baselineをローカルの提出APIへ送ります。

```sh
./scripts/enqueue-demo-submissions.sh
```

主要なディレクトリは次のとおりです。

- `apps/web`：ReactとViteで構成したフロントエンド
- `apps/server`：Hono API、worker、migration
- `apps/runner`：forced-command SSH gatewayとDocker計測処理
- `apps/mock-auth`：ローカル用認証proxy
- `packages/contracts`：Hono RPCとZodの共有contract
- `cmd/contest_data`：データ生成とR2へのupload
- `infra/cloudflare`：データセット用R2 bucket
- `infra/cdk`：計測用EC2
- `infra/ansible`：計測ホストの構成

API process内のworker loopはDBの実行キューから提出を一件ずつ取得し、専用ホストのrunnerへSSHで計測を依頼します。
runnerが返したpublic/privateの各計測結果を保存し、リーダーボードに使う代表提出を更新します。
実際のプログラム実行は専用ホストで行い、API processでは非同期I/Oだけを扱うため、提出リクエストとSSE配信を長時間の計測で塞ぎません。

依存関係はBun workspaceで管理し、lockfileは `bun.lock` です。
GitHub Actionsの参照を更新するときは `mise exec -- pinact run` を実行します。

## NeoShowcaseへのデプロイ

本番ではAPIとworker loopを一つのNeoShowcase applicationで起動します。
計測だけをNeoShowcase外の専用EC2で実行します。

事前に次の環境を用意します。

- application DBにMariaDB 11.8.8を使うNeoShowcase
- Cloudflareアカウント
- AWSアカウントとEC2 key pair
- Terraform、Ansible、rsync、AWS CLI
- NeoShowcase applicationから計測ホストの22番portへ到達できる経路

### R2 bucket

Terraformがコンテストデータ用bucketを作成します。
Cloudflare API tokenには対象アカウントのR2 bucketを編集できる権限を付けます。

```sh
cp infra/cloudflare/terraform.tfvars.example infra/cloudflare/terraform.tfvars
export CLOUDFLARE_API_TOKEN=replace-with-cloudflare-api-token
terraform -chdir=infra/cloudflare init
terraform -chdir=infra/cloudflare plan
terraform -chdir=infra/cloudflare apply
```

R2のS3 API credentialはCloudflare dashboardで二つ発行します。
データ投入用credentialにはObject Read and Writeを付け、API用credentialには対象bucketのObject Readだけを付けます。
Terraform providerはS3 API access keyを発行しないため、この操作だけはdashboardで行います。

### コンテストデータ

生成物には非公開データが含まれるため、`data/` はGit管理外です。

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
  --bucket "$(terraform -chdir=infra/cloudflare output -raw bucket_name)" \
  --account-id "$R2_ACCOUNT_ID" \
  --access-key "$R2_WRITE_ACCESS_KEY_ID" \
  --secret-key "$R2_WRITE_SECRET_ACCESS_KEY"
```

### 計測ホスト

CDKはUbuntu 26.04 amd64、暗号化gp3 volume、EIP、SSH ingress ruleを作成します。
SSHのデフォルトCIDRは `0.0.0.0/0` です。
接続元を限定する場合はdeploy時に `-c allowedSshCidr=203.0.113.10/32` を追加します。

API内worker専用の鍵はforced-command付きで登録されるため、任意のshell commandには使えません。

```sh
ssh-keygen -t ed25519 -N '' -C onebrc-worker -f ~/.ssh/onebrc-worker

mise exec -- bun run --filter @1brc/cdk synth \
  -c keyPairName=onebrc-admin
mise exec -- bun run --filter @1brc/cdk deploy \
  -c keyPairName=onebrc-admin \
  --outputs-file cdk-outputs.json
```

Ansible用のinventory、runner公開鍵、環境ID、データのSHA-256はスクリプトが生成します。
Ansibleはrunnerを構成し、`data/runner` の4ファイルをrsyncしてchecksumを検証します。

```sh
mise exec -- bun run --filter @1brc/runner build
mise exec -- bun scripts/configure-ansible.ts \
  --cdk-outputs infra/cdk/cdk-outputs.json \
  --ssh-private-key ~/.ssh/onebrc-admin.pem \
  --runner-public-key ~/.ssh/onebrc-worker.pub \
  --data-dir data/runner

ansible-galaxy collection install -r infra/ansible/requirements.yml
ansible-playbook -i infra/ansible/inventory.yml infra/ansible/playbook.yml
```

計測ホストを作り直すか、runner image、データセット、計測条件を変えた場合は、CDK contextの `benchmarkEnvironmentId` も変更します。
異なる環境の実行時間を同じリーダーボードに混在させないためです。

### Application

NeoShowcaseでrepositoryを登録し、applicationを次の値で作成します。

| 設定                   | 値                            |
| ---------------------- | ----------------------------- |
| Application Type       | Runtime                       |
| Build Type             | Dockerfile                    |
| Context                | `.`                           |
| Dockerfile Name        | `infra/docker/app.Dockerfile` |
| Use Database           | Yes / MariaDB                 |
| Auto Shutdown          | Off                           |
| Entrypoint / Command   | 空欄                          |
| Website Port           | `3000`                        |
| Website Authentication | HARD                          |

HARD認証が付ける `X-Forwarded-User` をAPIがユーザー名として使います。
公開websiteにはHTTPSを設定し、path prefixは `/` にします。

NeoShowcaseはMariaDBを有効にしたapplicationへ `NS_MARIADB_*` を自動設定します。
次の値をapplicationの環境変数に追加します。

| 分類     | 変数                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| アプリ   | `NODE_ENV=production`, `APP_ORIGIN`, `CONTEST_ID`, `CONTEST_START_AT`, `CONTEST_END_AT`, `ADMIN_USERS`, `TRUST_PROXY_HEADER=true` |
| R2       | `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`                                      |
| runner   | `RUNNER_SSH_HOST`, `RUNNER_SSH_PORT=22`, `RUNNER_SSH_USER=onebrc`, `RUNNER_SSH_PRIVATE_KEY_BASE64`, `RUNNER_SSH_HOST_KEY_SHA256`  |
| 計測環境 | `BENCHMARK_ENVIRONMENT_ID`, `BENCHMARK_INSTANCE_TYPE`, `BENCHMARK_RUNNER_IMAGE`                                                   |

`R2_ENDPOINT` には `terraform -chdir=infra/cloudflare output -raw s3_endpoint` の結果を設定します。
worker loop用秘密鍵とホスト鍵fingerprintは次のコマンドで環境変数向けの値に変換できます。

```sh
base64 -w 0 ~/.ssh/onebrc-worker
ssh-keyscan -t ed25519 BENCHMARK_IP 2>/dev/null | ssh-keygen -lf - -E sha256
```

秘密鍵は `RUNNER_SSH_PRIVATE_KEY_BASE64` に一行で設定します。
`ssh-keygen` の出力にある `SHA256:...` を `RUNNER_SSH_HOST_KEY_SHA256` に設定します。

APIは起動時に未適用のSQL migrationを実行し、worker loopを開始してからHTTP serverを起動します。
最初のbuildが起動したら、運営管理画面から `data/contest/manifest.json` を取り込みます。

rolling deployで新旧replicaが重なっても、DBのadvisory lockを取得した一つのworker loopだけがキューを処理します。
待機側のreplicaはHTTPを提供したままlockを再取得するため、新しいreplicaのhealth checkを妨げません。

## Migration

SQLファイルは `apps/server/migrations` に連番で追加します。
API起動時のmigrationはMariaDBのadvisory lockを取得し、`schema_migrations` に未記録のファイルだけをファイル名順に適用します。
同じ処理はローカルで単独実行できます。

```sh
mise exec -- bun run db:migrate
```
