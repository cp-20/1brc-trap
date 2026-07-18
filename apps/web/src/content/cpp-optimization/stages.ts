import naiveSource from "./01-naive.cpp?raw";
import fixedMonthSource from "./02-fixed-month.cpp?raw";
import noStringstreamSource from "./03-no-stringstream.cpp?raw";
import directNumbersSource from "./04-direct-numbers.cpp?raw";
import splitKeySource from "./05-split-key.cpp?raw";
import flatMapSource from "./06-flat-map.cpp?raw";
import mmapSource from "./07-mmap.cpp?raw";
import monthTableSource from "./08-month-table.cpp?raw";
import parallelSource from "./09-parallel.cpp?raw";

export type OptimizationStage = {
  id: string;
  title: string;
  shortTitle: string;
  filename: string;
  flamegraphFocus: readonly string[];
  source: string;
  goal: string;
  diagnosis: string;
  verification: string;
  explanation: readonly string[];
  diff: string | null;
  diffNote: string | null;
  benchmark: {
    wallSeconds: number;
    changePercent: number | null;
    overallPercent: number;
    bottleneck: string;
    nextEvidence: string;
  };
};

export const cppOptimizationStages: readonly OptimizationStage[] = [
  {
    id: "naive",
    title: "まずは読みやすく解く",
    shortTitle: "ナイーブ版",
    filename: "01-naive.cpp",
    flamegraphFocus: ["strftime", "gmtime_r"],
    source: naiveSource,
    goal: "`std::getline`、`std::stringstream`、`std::unordered_map`を使い、CSVを一行ずつ集計する実装から始めます。",
    diagnosis:
      "まず、正しい基準実装を1B行で測ります。perf statでは命令数が422億、分岐数が89.5億でした。高速化の前に、どれだけの仕事をしているかをこの値で固定します。",
    verification:
      "期待出力との一致を確認し、実行時間は420.06秒でした。この値を以降の比較対象にします。",
    explanation: [
      "`std::ifstream`でCSVを開き、`std::getline`で一行ずつ`std::string`へ読み込みます。各行を`std::stringstream`へ渡し、4回の`std::getline`で時刻、チャンネル、メッセージ長、スタンプ数に分割します。",
      "数値列は`std::stoll`と`std::stoi`で整数へ変換します。時刻は`gmtime_r`でUTCの日時構造体へ直し、`strftime`で`YYYY-MM`形式の文字列へ変換します。",
      "集計には`std::unordered_map<std::string, Stats>`を使います。チャンネル名と年月を連結した文字列をキーにして、`Stats`の最小値、最大値、合計、件数、スタンプ数を更新します。",
    ],
    diff: null,
    diffNote: null,
    benchmark: {
      wallSeconds: 420.06,
      changePercent: null,
      overallPercent: 0,
      bottleneck: "全行で呼ぶ`gmtime_r`と`strftime`",
      nextEvidence:
        "フレームグラフでは`__strftime_l`だけで6.61%を占め、`strftime`と`gmtime_r`も同じ呼び出し経路に現れました。主ループを見ると、これらを10億回呼んでいます。入力年が2027年に限られるのに汎用日時変換を使っているため、最初のボトルネックと判断します。",
    },
  },
  {
    id: "fixed-month",
    title: "年月変換を固定境界へ替える",
    shortTitle: "年月変換",
    filename: "02-fixed-month.cpp",
    flamegraphFocus: ["basic_stringstream", "getline"],
    source: fixedMonthSource,
    goal: "`gmtime_r`と`strftime`を、2027年の月境界を持つ`MONTH_START`との比較へ置き換えます。",
    diagnosis:
      "前段のフレームグラフで汎用日時変換のまとまりを見つけ、コード上でも10億回呼ばれることを確認しました。そこで、CSVの読み方と集計表を保ったまま日時変換だけを外します。",
    verification:
      "実行時間は420.06秒から346.09秒へ17.6%短縮しました。命令数も422億から349億へ減ったため、日時変換をボトルネックとした仮説を採用できます。",
    explanation: [
      "2027年の各月が始まるUnix秒を`MONTH_START`へ置きます。`month_index`は時刻をこの境界と比較し、0から11の月番号を返します。",
      "`gmtime_r`と`strftime`を`month_index(std::stoll(timestamp))`へ置き換えます。CSVの分割と集計表は残すため、日時変換だけの効果を測れます。",
    ],
    diff: `-#include <ctime>

+constexpr long long MONTH_START[] = { /* 12か月の境界 */ };
+constexpr const char *MONTH_LABEL[] = { /* 2027-01から2027-12 */ };

-gmtime_r(&seconds, &utc);
-std::strftime(month, sizeof(month), "%Y-%m", &utc);
+int month = month_index(std::stoll(timestamp));`,
    diffNote: "ボトルネックだった年月変換だけを交換しています。",
    benchmark: {
      wallSeconds: 346.09,
      changePercent: 17.6,
      overallPercent: 17.6,
      bottleneck: "各行で構築する`std::stringstream`",
      nextEvidence:
        "次のフレームグラフには、localeのキャッシュ処理が4.36%現れ、`std::stringstream`の構築、破棄、`std::getline`が複数のスタックへ広がっています。個々の関数ではなく、各行で`std::stringstream`を作る処理全体を次の対象にします。",
    },
  },
  {
    id: "no-stringstream",
    title: "カンマを直接探す",
    shortTitle: "列を直接探す",
    filename: "03-no-stringstream.cpp",
    flamegraphFocus: ["__stoa", "::substr"],
    source: noStringstreamSource,
    goal: "`std::stringstream`を外し、`std::string::find`で3個のカンマを直接探します。数値変換はまだ`stoi`と`stoll`のままです。",
    diagnosis:
      "前段では、stringstreamに伴うlocale処理と複数のgetlineがフレームグラフへ現れました。列の区切りはカンマ3個だけなので、汎用ストリームを使わず位置を直接探します。",
    verification:
      "実行時間は346.09秒から241.71秒へ30.2%短縮しました。命令数は349億から209億、分岐数は77.2億から48.7億へ減り、列分割の仕事を実際に削れています。",
    explanation: [
      "行全体を読む`std::getline`は残し、`line.find(',')`を3回使って列の境界を求めます。`substr`で各列を取り出せば、`std::stringstream`の状態管理とlocale処理を通りません。",
      "数値列の`substr`と`std::stoi`、`std::stoll`は意図的に残します。列分割以外を変えないことで、`std::stringstream`を外した効果だけを比較します。",
    ],
    diff: `-std::stringstream row(line);
-std::string timestamp, channel, length_text, stamps_text;
-std::getline(row, timestamp, ',');
-std::getline(row, channel, ',');
-std::getline(row, length_text, ',');
-std::getline(row, stamps_text, ',');
+size_t comma1 = line.find(',');
+size_t comma2 = line.find(',', comma1 + 1);
+size_t comma3 = line.find(',', comma2 + 1);
+std::string timestamp = line.substr(0, comma1);
+std::string channel = line.substr(comma1 + 1, comma2 - comma1 - 1);`,
    diffNote: "ボトルネックだった列分割だけを交換しています。",
    benchmark: {
      wallSeconds: 241.71,
      changePercent: 30.2,
      overallPercent: 42.5,
      bottleneck: "数値列の一時文字列と`stoi`、`stoll`",
      nextEvidence:
        "新しいフレームグラフでは、`stoi`と`stoll`の内部処理が合計13.21%、`substr`が3.52%を占めました。数値を読む前に一時文字列を作り、汎用変換へ渡す経路が次のボトルネックです。",
    },
  },
  {
    id: "direct-numbers",
    title: "数字をその場で整数へ変える",
    shortTitle: "数値を直接読む",
    filename: "04-direct-numbers.cpp",
    flamegraphFocus: ["_M_equals", "_Hash_bytes", "_M_append"],
    source: directNumbersSource,
    goal: "数値列の`substr`、`stoi`、`stoll`を外し、数字を左から読む`parse_number`へ置き換えます。",
    diagnosis:
      "前段のフレームグラフで、数値変換とsubstrのスタックがまとまって残りました。入力は非負の10進整数に限られるため、文字列を作らず数字を左から直接読みます。",
    verification:
      "実行時間は241.71秒から184.06秒へ23.9%短縮しました。命令数は209億から123億、分岐数は48.7億から26.5億へ減りました。",
    explanation: [
      "`parse_number`は列の先頭から末尾まで数字を読み、`value = value * 10 + digit`で整数を組み立てます。入力が非負の10進整数だと保証されているため、符号、空白、基数を扱う汎用変換は不要です。",
      "時刻、メッセージ長、スタンプ数の`substr`と`std::stoi`、`std::stoll`を`parse_number`へ置き換えます。チャンネル名だけは集計キーとして必要なので、まだ`std::string`へコピーします。",
    ],
    diff: `-std::string timestamp = line.substr(0, comma1);
-std::string length_text = line.substr(comma2 + 1, comma3 - comma2 - 1);
-std::string stamps_text = line.substr(comma3 + 1);
-int length = std::stoi(length_text);
-int stamps = std::stoi(stamps_text);
+long long timestamp = parse_number(line, 0, comma1);
+int length = parse_number(line, comma2 + 1, comma3);
+int stamps = parse_number(line, comma3 + 1, line.size());`,
    diffNote: "ボトルネックだった数値列の生成と変換だけを交換しています。",
    benchmark: {
      wallSeconds: 184.06,
      changePercent: 23.9,
      overallPercent: 56.2,
      bottleneck: "チャンネル名と年月を連結する`std::string`の複合キー",
      nextEvidence:
        "新しいフレームグラフでは、ハッシュ表のキー比較が10.77%、`std::string::append`が4.82%、`std::_Hash_bytes`が4.72%を占めました。主ループを見ると、チャンネル名と年月を毎行連結してから表を引いています。",
    },
  },
  {
    id: "split-key",
    title: "チャンネルと月を別々に持つ",
    shortTitle: "複合キーを外す",
    filename: "05-split-key.cpp",
    flamegraphFocus: ["_M_equals", "_Hash_bytes"],
    source: splitKeySource,
    goal: "値を`std::array<Stats, 12>`へ変え、月を配列の添字として持つことで複合キーをなくします。",
    diagnosis:
      "前段では、複合キーの生成、ハッシュ計算、比較がフレームグラフの広い部分を占めました。月は12種類しかないため、チャンネルごとの配列へ分離して連結をなくします。",
    verification:
      "実行時間は184.06秒から98.18秒へ46.7%短縮しました。今回も集計キー以外を変えていないため、短縮分をキー表現の効果として判断できます。",
    explanation: [
      "値を`std::array<Stats, 12>`に変え、ハッシュ表のキーをチャンネル名だけにします。月番号は配列の添字として使うため、`channel + ',' + month`という文字列を作る必要がなくなります。",
      "年月ラベルは結果を書き出すときだけ`MONTH_LABEL[month]`から取得します。主ループでは短いチャンネル名だけをハッシュ計算します。",
    ],
    diff: `-std::unordered_map<std::string, Stats> stats;
+std::unordered_map<std::string, std::array<Stats, 12>> stats;

-int month = month_index(timestamp);
-Stats &s = stats[channel + "," + MONTH_LABEL[month]];
+Stats &s = stats[channel][month_index(timestamp)];`,
    diffNote: "ボトルネックだった集計キーの表現だけを変更しています。",
    benchmark: {
      wallSeconds: 98.18,
      changePercent: 46.7,
      overallPercent: 76.6,
      bottleneck: "毎行のチャンネル名コピーと`std::unordered_map`の検索",
      nextEvidence:
        "複合キーを外した後も、フレームグラフではハッシュ表のキー比較が8.56%、ハッシュ計算が5.21%を占めます。コード上ではチャンネル名を毎行コピーしているため、入力仕様に合わせた単純な表を次に試します。",
    },
  },
  {
    id: "flat-map",
    title: "チャンネル名を初回だけ保存する",
    shortTitle: "専用ハッシュ表",
    filename: "06-flat-map.cpp",
    flamegraphFocus: ["getline"],
    source: flatMapSource,
    goal: "`std::unordered_map`を、16,384枠の開番地法で実装した`FlatMap`へ置き換えます。",
    diagnosis:
      "前段では、複合キーを外しても汎用ハッシュ表の比較とハッシュ計算が残りました。チャンネル数が最大10,000と分かっているため、16,384枠の開番地法へ替えます。",
    verification:
      "実行時間は98.18秒から73.46秒へ25.2%短縮しました。命令数も87.9億から72.3億へ減り、専用表へ替えた効果を確認できました。",
    explanation: [
      "`FlatMap`は16,384個の`Entry`を先に確保します。CSV上のチャンネル名からFNV-1aハッシュを計算し、対応する位置が使用中なら空きが見つかるまで次の位置を調べます。",
      "既存チャンネルではCSV上の文字列と保存済みの名前を直接比較します。`std::string::assign`を呼ぶのは新しいチャンネルを初めて見つけたときだけです。",
    ],
    diff: `-std::unordered_map<std::string, std::array<Stats, 12>> stats;
-std::string channel = line.substr(comma1 + 1, comma2 - comma1 - 1);
-Stats &s = stats[channel][month_index(timestamp)];
+FlatMap stats;
+Entry &entry = stats.find_or_insert(line.data() + comma1 + 1,
+                                    comma2 - comma1 - 1);
+Stats &s = entry.months[month_index(timestamp)];`,
    diffNote:
      "行の読み方は変えず、ボトルネックだった集計表だけを交換しています。",
    benchmark: {
      wallSeconds: 73.46,
      changePercent: 25.2,
      overallPercent: 82.5,
      bottleneck: "`std::getline`が行ごとに行う`std::string`へのコピー",
      nextEvidence:
        "新しいフレームグラフでは、専用表の検索が20.48%、getlineが19.62%でした。表は今替えたばかりなので、独立して外せるgetlineの行コピーを次の比較対象にします。",
    },
  },
  {
    id: "mmap",
    title: "ファイル上の文字を直接読む",
    shortTitle: "行コピーを外す",
    filename: "07-mmap.cpp",
    flamegraphFocus: ["month_index"],
    source: mmapSource,
    goal: "`std::getline`を`mmap`とポインタ走査へ置き換え、行を`std::string`へコピーする処理をなくします。",
    diagnosis:
      "前段のフレームグラフでは、getlineが19.62%を占めました。集計方法を保ったまま入力ファイルをmmapし、カンマと改行をファイル上で直接探します。",
    verification:
      "本番と同じ3回の中央値は46.66秒で、73.46秒から36.5%短縮しました。命令数は72.3億から47.1億へ減り、1B計測のsystem時間も4.63秒から0.77秒へ下がりました。",
    explanation: [
      "`open`と`mmap`でファイルを読み取り専用のメモリ領域へ対応付けます。`cursor`から`std::find`でカンマと改行を探し、数値変換とハッシュ計算へポインタの範囲をそのまま渡します。",
      "これにより、`std::getline`が行ごとに行っていた`std::string`へのコピーを削除できます。集計表と一行の計算方法は変えません。",
    ],
    diff: `-std::ifstream input(argv[1]);
-std::string line;
-while (std::getline(input, line)) {
-  size_t comma1 = line.find(',');
+MappedFile input(argv[1]);
+const char *cursor = std::find(input.data, end, '\\n') + 1;
+while (cursor < end) {
+  const char *comma1 = std::find(cursor, end, ',');`,
    diffNote:
      "集計方法は変えず、ボトルネックだった入力の渡し方だけを交換しています。",
    benchmark: {
      wallSeconds: 46.66,
      changePercent: 36.5,
      overallPercent: 88.9,
      bottleneck: "`month_index`が行う最大12回の境界比較",
      nextEvidence:
        "入力を軽くした後のフレームグラフにはmonth_indexが現れ、perf statでは10M行あたり2,685万回の分岐ミスがありました。month_indexは最大12回の比較を全行で行うため、分岐を一回の表引きへ替えます。",
    },
  },
  {
    id: "month-table",
    title: "月を一回の表引きで求める",
    shortTitle: "月を表引き",
    filename: "08-month-table.cpp",
    flamegraphFocus: ["main"],
    source: monthTableSource,
    goal: "`month_index`の境界比較を、365要素の`MONTH_BY_DAY`から月番号を読む処理へ置き換えます。",
    diagnosis:
      "前段ではmonth_indexがフレームグラフに残り、分岐ミスも2,685万回ありました。入力が2027年だけという条件を使い、日番号から月を引く365要素の表へ替えます。",
    verification:
      "3回の中央値は38.93秒で、46.66秒から16.6%短縮しました。10M行の分岐ミスは2,685万回から1,631万回へ39.2%減り、狙った分岐を削れています。",
    explanation: [
      "2027年の各日について月番号を持つ`MONTH_BY_DAY`をコンパイル時に作ります。時刻から`YEAR_START`を引いて86,400で割ると、0から364の日番号を得られます。",
      "`month_index`を最大12回の境界比較から`MONTH_BY_DAY[day]`の一回の参照へ置き換えます。これにより、月によって回数が変わる分岐を主ループから外します。",
    ],
    diff: `-for (int month = 0; month < 12; ++month) {
-  if (timestamp < MONTH_START[month + 1]) return month;
-}
+constexpr auto MONTH_BY_DAY = make_month_table();
+return MONTH_BY_DAY[(timestamp - YEAR_START) / 86400];`,
    diffNote: "ボトルネックだった月判定だけを交換しています。",
    benchmark: {
      wallSeconds: 38.93,
      changePercent: 16.6,
      overallPercent: 90.7,
      bottleneck: "一つのCPUコアだけで動く`analyze`のCSV解析と集計",
      nextEvidence:
        "perf statのtask-clockは実行時間とほぼ同じで、処理が一つのCPUコアに閉じています。入力行は独立しており、チャンネルごとの統計は最後に足し合わせられるため、行の範囲を複数コアへ分けられます。",
    },
  },
  {
    id: "parallel",
    title: "8個の範囲を並列に集計する",
    shortTitle: "8スレッド",
    filename: "09-parallel.cpp",
    flamegraphFocus: ["FlatMap::find_or_insert", "parse_number"],
    source: parallelSource,
    goal: "入力を改行位置で8分割し、8個の`analyze`を並列実行してスレッドごとの`FlatMap`を最後に併合します。",
    diagnosis:
      "前段のperf statから、一つのCPUコアしか使っていないと分かりました。改行位置で入力を8分割し、ロックを避けるため各スレッドが別の集計表を持つ構成にします。",
    verification:
      "3回の中央値は7.80秒で、38.93秒から80.0%短縮しました。1B計測ではuser時間58.59秒に対して実時間7.80秒となり、約7.5コア分を並列に使えています。",
    explanation: [
      "ファイルをほぼ同じバイト数の8範囲へ分け、各境界を次の改行まで進めます。各スレッドは完全な行だけを受け取り、自分専用の`FlatMap`へ集計します。",
      "共有する集計表がないため、主ループにmutexは不要です。全スレッドの終了後に7個の表を先頭の表へ`merge`し、最小値、最大値、合計、件数を結合します。",
    ],
    diff: `-FlatMap stats = analyze(begin, end);
+std::vector<FlatMap> local(THREADS);
+for (int i = 0; i < THREADS; ++i) {
+  workers.emplace_back([&, i] {
+    local[i] = analyze(boundary[i], boundary[i + 1]);
+  });
+}
+for (std::thread &worker : workers) worker.join();
+FlatMap stats = std::move(local[0]);
+for (int i = 1; i < THREADS; ++i) stats.merge(local[i]);`,
    diffNote:
      "一行の処理は変えず、独立した範囲へ配る処理だけを追加しています。",
    benchmark: {
      wallSeconds: 7.8,
      changePercent: 80.0,
      overallPercent: 98.1,
      bottleneck:
        "各スレッド内の`FlatMap::find_or_insert`、`parse_number`、カンマ探索",
      nextEvidence:
        "最後のフレームグラフではanalyzeが57.85%を占め、その内側で専用表の検索が34.20%、数値変換が6.68%でした。次に進むなら、各スレッドで10億行分繰り返す文字列ハッシュとCSV解析が対象です。",
    },
  },
];
