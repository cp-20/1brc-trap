# 1BLC Trap

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
