#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

base_url="${DEMO_BASE_URL:-http://localhost:8080}"
base_url="${base_url%/}"
source_file="baselines/ts/main.ts"
users="mina Pugma sakura Hueter Dye hayatroid comavius ogu_kazemiya Synori Alt--er Polan Kasyu shogotin ue"

case "$base_url" in
  http://localhost | http://localhost:* | http://127.0.0.1 | http://127.0.0.1:*) ;;
  *)
    echo "ローカル環境以外には提出できません: $base_url" >&2
    exit 1
    ;;
esac

if [ ! -f "$source_file" ]; then
  echo "提出用baselineが見つかりません: $source_file" >&2
  exit 1
fi
if ! curl -fsS "$base_url/api/v1/healthz" >/dev/null; then
  echo "ローカル環境を起動してください: ./scripts/setup-local.sh" >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT INT TERM

echo "TypeScript baselineを同時に提出します"
pids=""
for username in $users; do
  (
    response_file="$temporary_directory/$username.json"
    if ! status="$(
      curl --silent --show-error \
        --output "$response_file" \
        --write-out '%{http_code}' \
        -H "Cookie: onebrc_user=$username" \
        -H "Origin: $base_url" \
        -F "executionKind=typescript" \
        -F "source=@$source_file;filename=main.ts;type=text/plain" \
        "$base_url/api/v1/submissions"
    )"; then
      echo "[$username] APIへ接続できませんでした" >&2
      exit 1
    fi

    if [ "$status" = "202" ]; then
      echo "[$username] キューへ追加しました"
      exit 0
    fi
    if [ "$status" = "409" ] && grep -q '"code":"active_submission"' "$response_file"; then
      echo "[$username] すでに処理中の提出があるためスキップしました"
      exit 0
    fi

    echo "[$username] 提出に失敗しました (HTTP $status)" >&2
    sed -n '1p' "$response_file" >&2
    exit 1
  ) &
  pids="$pids $!"
done

failed=0
for pid in $pids; do
  if ! wait "$pid"; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "確認先: $base_url/leaderboard"
echo "提出状況: docker compose logs -f api"
