import { Link } from "react-router-dom";
import { CodeBlock } from "../code-block.js";
import { Select } from "../select.js";
import { languageLabel } from "../../models/labels.js";
import type { SubmissionDraft } from "../../models/submission.js";
import {
  executionKinds,
  nativeBuildGuides,
  nativeLanguages,
} from "../../models/submission-options.js";
import styles from "../../pages/submit-page.module.css";
import { CopyableCode, StepHeading } from "./submit-step.js";

export function ProgramStep() {
  return (
    <section className={styles.step}>
      <StepHeading
        number={1}
        title="プログラムを作成する"
        description="入力ファイルと出力先を、順番にコマンドライン引数で受け取るプログラムを作ります。"
      />
      <div className={styles.stepContent}>
        <CodeBlock lang="shellscript">
          $ ./program input.csv output.txt
        </CodeBlock>
        <p className={styles.explanation}>
          第1引数のCSVを読み、集計結果を第2引数のファイルへ書き込んでください。標準入力・標準出力は入出力には使いません。
        </p>
        <Link className="text-link" to="/contest#input-output">
          入出力フォーマットと例を確認する
        </Link>
      </div>
    </section>
  );
}

export function RuntimeStep({
  draft,
  update,
}: {
  draft: SubmissionDraft;
  update: (change: Partial<SubmissionDraft>) => void;
}) {
  const selected = executionKinds[draft.executionKind];
  return (
    <section className={styles.step}>
      <StepHeading
        number={2}
        title="実行方法を選ぶ"
        description="提出するプログラムを動かすランタイムを指定します。"
      />
      <div className={styles.stepContent}>
        <label className={styles.stackedField}>
          <span>ランタイム</span>
          <Select
            ariaLabel="ランタイム"
            value={draft.executionKind}
            options={Object.entries(executionKinds).map(([value, item]) => ({
              value,
              label: item.label,
            }))}
            onValueChange={(value) =>
              update({
                executionKind: value as SubmissionDraft["executionKind"],
                source: null,
                binary: null,
              })
            }
          />
        </label>
        <p className={styles.fieldHelp}>{selected.description}</p>
        {draft.executionKind === "native" && (
          <label className={styles.stackedField}>
            <span>実装言語</span>
            <Select
              ariaLabel="実装言語"
              value={draft.language}
              options={nativeLanguages.map((language) => ({
                value: language,
                label: languageLabel(language),
              }))}
              onValueChange={(value) =>
                update({
                  language: value as SubmissionDraft["language"],
                  source: null,
                  binary: null,
                })
              }
            />
          </label>
        )}
      </div>
    </section>
  );
}

export function NativeBuildStep({ draft }: { draft: SubmissionDraft }) {
  if (draft.executionKind !== "native") return null;
  const guide =
    nativeBuildGuides[draft.language as keyof typeof nativeBuildGuides];
  return (
    <section className={styles.step}>
      <StepHeading
        number={3}
        title="Linux x86_64向けにビルドする (主に Mac の人向け)"
        description="提出する実行ファイルは、計測環境と同じアーキテクチャ向けに作成します。"
      />
      <div className={styles.stepContent}>
        <CopyableCode value={guide.command} />
        <p className={styles.fieldHelp}>{guide.note}</p>
        <dl className={styles.buildResult}>
          <div>
            <dt>提出する実行ファイル</dt>
            <dd>{guide.output}</dd>
          </div>
          <div>
            <dt>必要な形式</dt>
            <dd>ELF 64-bit LSB executable, x86-64</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
