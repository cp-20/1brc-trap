# 1BLC Trap

Utilities and baseline implementations for aggregating generated traQ message data.

## Layout

- `cmd/traq_data/`: generator for synthetic traQ message CSV data.
- `baselines/`: baseline analyzers in Go, C, C++, C#, Ruby, Rust, TypeScript, and Zig.
- `data/`: local generated CSV files. These are intentionally ignored by Git.

## Example

```sh
go run ./cmd/traq_data -n 100000 -o data/traq_data.csv
go run ./baselines/go -i data/traq_data.csv -o traq_baseline.out
```
