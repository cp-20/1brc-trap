#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if ! command -v mise >/dev/null 2>&1; then
  echo "miseが必要です: https://mise.jdx.dev/getting-started.html" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "DockerとDocker Composeが必要です" >&2
  exit 1
fi

echo "[1/6] miseで開発ツールを準備します"
mise trust mise.toml >/dev/null
mise install

echo "[2/6] Bunで依存関係をインストールします"
mise exec -- bun install --frozen-lockfile

if [ ! -f data/contest/manifest.json ]; then
  echo "[3/6] Goだけでローカルfixtureとexpectedを生成します"
  mise exec -- go run ./cmd/contest_data generate \
    --contest-id 1brc-trap-local \
    --output data/contest \
    --runner-dir data/local \
    --public-rows 100000 \
    --private-rows 100000 \
    --tiers 1000,10000,100000 \
    --threads 2 \
    --revision local
else
  echo "[3/6] 既存のdata/contest/manifest.jsonを利用します"
fi

echo "[4/6] MariaDB・RustFS・計測ホストを起動します"
docker compose up -d --build mariadb rustfs rustfs-init benchmark-host
attempt=0
until curl -sS -o /dev/null http://localhost:9000/ 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "RustFSの起動を確認できませんでした" >&2
    docker compose logs --no-color rustfs >&2
    exit 1
  fi
  sleep 1
done

echo "[5/6] fixtureをRustFSへuploadします"
mise exec -- go run ./cmd/contest_data upload \
  --manifest data/contest/manifest.json \
  --endpoint http://localhost:9000 \
  --bucket onebrc-datasets \
  --access-key "${RUSTFS_ADMIN_ACCESS_KEY:-rustfsadmin}" \
  --secret-key "${RUSTFS_ADMIN_SECRET_KEY:-rustfsadmin}" \
  --create-bucket

echo "[6/6] アプリを起動し、manifestを取込みます"
docker compose up -d --build
attempt=0
until curl -fsS http://localhost:8080/api/v1/healthz >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 180 ]; then
    echo "アプリの起動を確認できませんでした" >&2
    docker compose logs --no-color api worker mock-auth >&2
    exit 1
  fi
  sleep 1
done

attempt=0
until docker compose logs --no-color benchmark-host 2>&1 | grep -q "Server listening"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 600 ]; then
    echo "計測runnerの起動を確認できませんでした" >&2
    docker compose logs --no-color benchmark-host >&2
    exit 1
  fi
  sleep 1
done

cookie_file="$(mktemp)"
trap 'rm -f "$cookie_file"' EXIT
curl -fsS -c "$cookie_file" -o /dev/null \
  "http://localhost:8080/_oauth/login?redirect=/"
curl -fsS -b "$cookie_file" \
  -H "Origin: http://localhost:8080" \
  -H "Content-Type: application/json" \
  --data-binary @data/contest/manifest.json \
  http://localhost:8080/api/v1/admin/datasets/import >/dev/null

echo "準備ができました: http://localhost:8080"
echo "開発用ユーザーはcp20、RustFS consoleはhttp://localhost:9001です"
