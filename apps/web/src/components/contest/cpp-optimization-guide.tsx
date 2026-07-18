import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  cppOptimizationStages,
  type OptimizationStage,
} from "../../content/cpp-optimization/stages.js";
import { CodeBlock } from "../ui.js";

import styles from "../../pages/contest-page.module.css";

export function CppOptimizationGuide() {
  const [selectedFlamegraph, setSelectedFlamegraph] =
    useState<OptimizationStage | null>(null);

  return (
    <>
      <div className={styles.document}>
        <aside className={styles.toc} aria-label="ページ内メニュー">
          <strong className={styles.tocTitle}>目次</strong>
          <a href="#optimization-method">ビルドと改善の進め方</a>
          {cppOptimizationStages.map((stage, index) => (
            <a key={stage.id} href={`#optimization-${stage.id}`}>
              {index + 1}. {stage.shortTitle}
            </a>
          ))}
        </aside>

        <article className={styles.body}>
          <section id="optimization-method" className={styles.section}>
            <p className={styles.number}>00</p>
            <h2>ビルドと改善の進め方</h2>
            <p>
              実行時間を測るバイナリは、全段階を同じオプションでビルドしました。
              <code>-O2</code>で最適化し、言語規格は<code>C++17</code>
              に固定しています。
              <code>-pthread</code>
              は第9段階で必要ですが、比較条件を揃えるため全段階へ付けています。
            </p>
            <CodeBlock lang="shellscript">{`g++ -O2 -std=c++17 -pthread main.cpp -o main`}</CodeBlock>
            <p>
              プロファイル用バイナリには<code>-g</code>と
              <code>-fno-omit-frame-pointer</code>を追加しました。
              掲載するフレームグラフは、このバイナリを10M行で動かして取得しています。
            </p>
            <CodeBlock lang="shellscript">{`g++ -O2 -g -fno-omit-frame-pointer -std=c++17 -pthread main.cpp -o main-profile`}</CodeBlock>

            <h3>改善の進め方</h3>
            <p>
              まず正しい実装を用意し、時間を使っている処理を一つ選び、その処理だけを変更してもう一度測ります。
            </p>
            <ol className={styles.optimizationCycle}>
              <li>
                <strong>観察する</strong>
                大量の行を処理するループから、全行で繰り返している処理を探します。
              </li>
              <li>
                <strong>一つだけ変える</strong>
                ほかの処理を残し、疑っている処理の効果だけを比較できるようにします。
              </li>
              <li>
                <strong>採用を決める</strong>
                出力が同じで、直前の実装より速くなった変更だけを残します。
              </li>
            </ol>
            <p>
              この順序なら、速くなった理由と次に調べる場所がつながります。
              以下の時間は、本番と同じ1B行を本番同等のEC2で測った値です。
              60秒未満の実装は本番と同じ3回の中央値を使い、
              <code>perf stat</code>とフレームグラフは10M行で取得しました。
              各段階の出力は1B行用の期待出力と照合しています。
            </p>
          </section>

          {cppOptimizationStages.map((stage, index) => (
            <StageSection
              key={stage.id}
              stage={stage}
              index={index}
              previousStage={cppOptimizationStages[index - 1] ?? null}
              onOpenFlamegraph={setSelectedFlamegraph}
            />
          ))}
        </article>
      </div>
      <FlamegraphDialog
        stage={selectedFlamegraph}
        onClose={() => setSelectedFlamegraph(null)}
      />
    </>
  );
}

function StageSection({
  stage,
  index,
  previousStage,
  onOpenFlamegraph,
}: {
  stage: OptimizationStage;
  index: number;
  previousStage: OptimizationStage | null;
  onOpenFlamegraph: (stage: OptimizationStage) => void;
}) {
  return (
    <section id={`optimization-${stage.id}`} className={styles.section}>
      <p className={styles.number}>{String(index + 1).padStart(2, "0")}</p>
      <h2>{stage.title}</h2>

      <h3>
        {index === 0 ? "基準実装を用意する" : "ボトルネックを探して改善する"}
      </h3>
      <p>
        <RichText text={index === 0 ? stage.goal : stage.diagnosis} />
      </p>

      {previousStage && (
        <>
          <Flamegraph
            stage={previousStage}
            onOpen={() => onOpenFlamegraph(previousStage)}
          />
          <p>
            改善するのは
            <RichText text={previousStage.benchmark.bottleneck} />
            です。
          </p>
          <p>
            <RichText text={stage.goal} />
          </p>
        </>
      )}
      {stage.explanation.map((paragraph) => (
        <p key={paragraph}>
          <RichText text={paragraph} />
        </p>
      ))}

      {stage.diff && (
        <div className={styles.diffSection}>
          <h3>直前の実装との差分</h3>
          <p>
            <RichText text={stage.diffNote!} />
          </p>
          <DiffBlock diff={stage.diff} />
        </div>
      )}

      <h3>{index === 0 ? "基準時間を計測する" : "改善を計測で確認する"}</h3>
      {index === 0 && (
        <p>
          <RichText text={stage.diagnosis} />
        </p>
      )}
      <Benchmark stage={stage} />
      <p>
        <RichText text={stage.verification} />
      </p>

      {index === cppOptimizationStages.length - 1 && (
        <>
          <h3>この先に残る処理</h3>
          <p>
            <RichText text={stage.benchmark.nextEvidence} />
          </p>
          <Flamegraph stage={stage} onOpen={() => onOpenFlamegraph(stage)} />
        </>
      )}

      <details className={styles.sourceDetails}>
        <summary>
          <span>この段階のコード全文</span>
          <code>{stage.filename}</code>
        </summary>
        <CodeBlock lang="cpp" className={styles.guideSource!}>
          {stage.source.trim()}
        </CodeBlock>
      </details>
    </section>
  );
}

function Flamegraph({
  stage,
  onOpen,
}: {
  stage: OptimizationStage;
  onOpen: () => void;
}) {
  const source = `/flamegraphs/cpp/${stage.filename.replace(".cpp", ".svg")}`;
  return (
    <figure className={styles.flamegraph}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${stage.title}のフレームグラフを拡大表示`}
      >
        <img
          src={source}
          alt={`${stage.title}のフレームグラフ`}
          loading="lazy"
        />
      </button>
      <figcaption>
        10M行で取得。クリックすると注目箇所を強調して拡大します。
      </figcaption>
    </figure>
  );
}

function FlamegraphDialog({
  stage,
  onClose,
}: {
  stage: OptimizationStage | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!stage || !dialog) return;

    const closeFromBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener("click", closeFromBackdrop);
    if (!dialog.open) dialog.showModal();

    return () => dialog.removeEventListener("click", closeFromBackdrop);
  }, [stage]);

  if (!stage) return null;
  const flamegraph = `/flamegraphs/cpp/${stage.filename.replace(".cpp", ".svg")}`;

  return (
    <dialog
      ref={dialogRef}
      className={styles.flamegraphDialog}
      onClose={onClose}
    >
      <div className={styles.flamegraphDialogContent}>
        <header className={styles.flamegraphDialogHeader}>
          <div>
            <h2>{stage.title}</h2>
            <p>
              強調表示: <RichText text={stage.benchmark.bottleneck} />
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="閉じる"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <object
          data={flamegraph}
          type="image/svg+xml"
          aria-label={`${stage.title}のフレームグラフ`}
          onLoad={(event) =>
            highlightFlamegraph(event.currentTarget, stage.flamegraphFocus)
          }
        />
      </div>
    </dialog>
  );
}

function highlightFlamegraph(
  object: HTMLObjectElement,
  focus: readonly string[],
) {
  const document = object.contentDocument;
  if (!document) return;

  for (const frame of document.querySelectorAll<SVGGElement>("#frames > g")) {
    const title = frame.querySelector("title")?.textContent ?? "";
    const isFocused = focus.some((name) => title.includes(name));
    const rect = frame.querySelector("rect");
    const text = frame.querySelector("text");

    frame.style.opacity = isFocused ? "1" : "0.5";
    if (rect) {
      if (isFocused) {
        rect.style.stroke = "#087da5";
        rect.style.strokeWidth = "2";
      }
    }
    if (text && isFocused) {
      text.style.fontWeight = "700";
    }
  }
}

function Benchmark({ stage }: { stage: OptimizationStage }) {
  return (
    <div className={styles.benchmarkGrid}>
      <div>
        <span>1B行の実行時間</span>
        <strong>{stage.benchmark.wallSeconds.toFixed(2)}秒</strong>
      </div>
      <div>
        <span>直前の実装から</span>
        <strong>{formatChange(stage.benchmark.changePercent)}</strong>
      </div>
      <div>
        <span>最初の実装から</span>
        <strong>{stage.benchmark.overallPercent.toFixed(1)}% 短縮</strong>
      </div>
    </div>
  );
}

function formatChange(change: number | null) {
  if (change === null) return "基準値";
  return `${change.toFixed(1)}% 短縮`;
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <CodeBlock lang="cpp" diff className={styles.diffBlock!}>
      {diff}
    </CodeBlock>
  );
}

function RichText({ text }: { text: string }) {
  const occurrences = new Map<string, number>();
  return text.split(/(`[^`]+`)/g).map((part) => {
    const occurrence = (occurrences.get(part) ?? 0) + 1;
    occurrences.set(part, occurrence);
    const key = `${part}:${occurrence}`;
    return part.startsWith("`") && part.endsWith("`") ? (
      <code key={key}>{part.slice(1, -1)}</code>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}
