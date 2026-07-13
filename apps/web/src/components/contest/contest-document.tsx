import { Download } from "lucide-react";
import { contestGateway } from "../../gateways/contest-gateway.js";
import { formatBytes } from "../../utils/format.js";
import styles from "../../pages/contest-page.module.css";
import { CodeBlock, Empty, ErrorAlert } from "../ui.js";

type Contest = Awaited<ReturnType<typeof contestGateway.contest>>;
type Datasets = Awaited<ReturnType<typeof contestGateway.datasets>>;

const inputExample = `unix_timestamp,channel_path,message_length,stamp_count
1798761600,team/dev/api,120,3
1798761660,team/dev/api,80,1
1801440000,team/dev/api,200,0
1798761720,team/web,50,2
1798761780,team/web,70,4`;

const outputExample = `team/dev/api,2027-01=80/100.00/120/2/4
team/dev/api,2027-02=200/200.00/200/1/0
team/web,2027-01=50/60.00/70/2/6`;

export function ContestDocument({
  environment,
  datasets,
  datasetsError,
}: {
  environment: Contest["environment"];
  datasets: Datasets | undefined;
  datasetsError: boolean;
}) {
  return (
    <div className={styles.document}>
      <aside className={styles.toc} aria-label="ページ内メニュー">
        <a href="#overview">概要</a>
        <a href="#input-output">入力と出力</a>
        <a href="#scoring">採点方法</a>
        <a href="#environment">計測環境</a>
        <a href="#submission-rules">提出に関する制限</a>
      </aside>
      <article className={styles.body}>
        <OverviewSection />
        <InputOutputSection datasets={datasets} datasetsError={datasetsError} />
        <ScoringSection />
        <EnvironmentSection environment={environment} />
        <SubmissionRulesSection />
      </article>
    </div>
  );
}

function OverviewSection() {
  return (
    <section id="overview" className={styles.section}>
      <p className={styles.number}>01</p>
      <h2>概要</h2>
      <p>
        traQのメッセージを模した巨大なCSVを読み込み、チャンネルと月ごとの統計を集計するプログラムを作ります。同じ答えを出せるプログラムのうち、実行時間が短いものほど上位になります。
      </p>
      <ol className={styles.taskFlow} aria-label="処理の流れ">
        <li>
          <strong>1</strong>
          <span>CSVを読み込む</span>
        </li>
        <li>
          <strong>2</strong>
          <span>チャンネル・月ごとに集計</span>
        </li>
        <li>
          <strong>3</strong>
          <span>結果をファイルへ出力</span>
        </li>
      </ol>
    </section>
  );
}

function InputOutputSection({
  datasets,
  datasetsError,
}: {
  datasets: Datasets | undefined;
  datasetsError: boolean;
}) {
  return (
    <section id="input-output" className={styles.section}>
      <p className={styles.number}>02</p>
      <h2>入力と出力</h2>
      <p>
        プログラムには、第1引数として入力CSV、第2引数として出力先のパスを渡します。標準入力からは読み込まず、結果は第2引数のファイルへ書き込んでください。
      </p>
      <CodeBlock lang="shellscript">$ ./program input.csv output.txt</CodeBlock>

      <h3>入力フォーマット</h3>
      <p>
        1行が1メッセージです。時刻はUnix秒、メッセージ長とスタンプ数は0以上の整数です。
      </p>
      <CodeBlock>
        unix_timestamp,channel_path,message_length,stamp_count
      </CodeBlock>
      <FieldTable
        fields={[
          ["unix_timestamp", "投稿時刻 (Unix秒)"],
          ["channel_path", "投稿先のチャンネルパス"],
          ["message_length", "メッセージの文字数"],
          ["stamp_count", "押されたスタンプの数"],
        ]}
      />

      <h3>入力例</h3>
      <p>
        次は形式を説明するための小さな例です。実際の計測では、はるかに多くの行を含むCSVを渡します。
      </p>
      <CodeBlock>{inputExample}</CodeBlock>

      <h3>出力フォーマット</h3>
      <p>チャンネルと月ごとに1行を出力します。各行は次の形式です。</p>
      <CodeBlock>
        channel_path,YYYY-MM=min_length/average_length/max_length/message_count/total_stamp_count
      </CodeBlock>
      <FieldTable
        fields={[
          ["channel_path", "集計対象のチャンネルパス"],
          ["YYYY-MM", "投稿時刻をUTCで変換した年月"],
          ["min_length", "メッセージ長の最小値"],
          ["average_length", "メッセージ長の平均値 (小数第2位まで)"],
          ["max_length", "メッセージ長の最大値"],
          ["message_count", "メッセージ数"],
          ["total_stamp_count", "スタンプ数の合計"],
        ]}
      />

      <h3>出力例</h3>
      <p>上の入力例を集計すると、次の3行を出力します。</p>
      <CodeBlock>{outputExample}</CodeBlock>

      <div className={styles.subsection}>
        <h3>公開データ</h3>
        <p>手元で正しさと実行方法を確認するための入力・期待出力です。</p>
        {datasetsError ? (
          <ErrorAlert message="公開データを取得できませんでした" />
        ) : datasets?.datasets.length === 0 ? (
          <Empty text="公開データはまだありません" />
        ) : (
          <div className={styles.datasetList}>
            {datasets?.datasets.map((dataset) => (
              <a
                key={dataset.id}
                href={dataset.downloadUrl}
                className={styles.datasetRow}
              >
                <span>
                  <strong>{dataset.label}</strong>
                  <small>
                    {Number(dataset.rows).toLocaleString()} 行 ·{" "}
                    {formatBytes(dataset.compressedBytes)}
                  </small>
                </span>
                <Download size={18} />
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FieldTable({ fields }: { fields: [string, string][] }) {
  return (
    <div className={styles.fieldTable}>
      {fields.map(([name, description]) => (
        <div key={name}>
          <code>{name}</code>
          <span>{description}</span>
        </div>
      ))}
    </div>
  );
}

function ScoringSection() {
  return (
    <section id="scoring" className={styles.section}>
      <p className={styles.number}>03</p>
      <h2>採点方法</h2>
      <ol className={styles.measureSteps}>
        <li>
          <span>1</span>
          <div>
            <strong>Public計測</strong>
            <p>
              公開データを使い、新しいプロセスで3回実行します。3回とも正解した場合は、実行時間の中央値をPublic結果として使用します。
            </p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>出力の検証</strong>
            <p>
              行の順序、LF/CRLF、空行は無視します。それ以外のキーと値は期待出力への完全一致が必要です。
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Private計測</strong>
            <p>
              Publicで正解した同じ提出を非公開データでも3回計測します。結果はコンテスト終了後に公開します。
            </p>
          </div>
        </li>
      </ol>
      <div className={styles.attention}>
        <strong>実行時の注意</strong>
        <ul>
          <li>標準出力・標準エラーは合計1 MiBまでです。</li>
          <li>出力ファイルは256 MiBまでです。</li>
          <li>ネットワークは無効で、実行環境は読み取り専用です。</li>
          <li>リーダーボードには各ユーザーの最新の正解提出が載ります。</li>
        </ul>
      </div>
    </section>
  );
}

function EnvironmentSection({
  environment,
}: {
  environment: Contest["environment"];
}) {
  const fields = [
    ["CPU", environment.cpu],
    ["メモリ", environment.memory],
    ["OS", environment.os],
    ["カーネル", environment.kernel],
    ["Docker", environment.docker],
    ["PID上限", String(environment.pidLimit)],
    ["Node.js", environment.node],
    ["Bun", environment.bun],
    ["Ruby", environment.ruby],
    ["制限時間", `${environment.timeoutSeconds}秒 / 回`],
  ];
  return (
    <section id="environment" className={styles.section}>
      <p className={styles.number}>04</p>
      <h2>計測環境</h2>
      <p>
        全提出を同じ環境で順番に計測します。Nativeの実行ファイルは、この環境で動作するようにビルドしてください。
      </p>
      <details className={styles.environment}>
        <summary>
          <span>
            <strong>{environment.os}</strong>
            <small>{environment.instanceType}</small>
          </span>
          <span>
            <strong>{environment.cpu}</strong>
            <small>{environment.memory}</small>
          </span>
        </summary>
        <dl className={styles.environmentGrid}>
          {fields.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.libraries}>
          <span>利用できる共有ライブラリ</span>
          <p>{environment.sharedLibraries.join(", ")}</p>
        </div>
      </details>
    </section>
  );
}

function SubmissionRulesSection() {
  return (
    <section id="submission-rules" className={styles.section}>
      <p className={styles.number}>05</p>
      <h2>提出に関する制限</h2>
      <div className={styles.ruleColumns}>
        <div>
          <h3>ファイル</h3>
          <ul>
            <li>ソースコードはUTF-8、NULなし、1 MiB以下の単一ファイル</li>
            <li>NativeはUbuntu 26.04 x86_64で動くELF実行ファイルも必要</li>
            <li>Native実行ファイルは64 MiB以下</li>
          </ul>
        </div>
        <div>
          <h3>利用できないもの</h3>
          <ul>
            <li>外部パッケージや同梱したライブラリ</li>
            <li>期待出力の埋め込み、データセット固有のハードコード</li>
            <li>ネットワークアクセス、sandboxの回避、ホストへの干渉</li>
          </ul>
        </div>
      </div>
      <p className={styles.sourcePolicy}>
        コンテスト終了後、各ユーザーの代表提出のソースコードを公開します。
      </p>
    </section>
  );
}
