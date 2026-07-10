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
