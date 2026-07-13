# Baselines

`main.ts` と `main.rb` は、そのまま提出できます。Webフォームでは実行形式をそれぞれ TypeScript / Ruby にし、対応する `main.*` をソースコードとして選択してください。

Native の基準実装はソースコードとビルド済みの実行ファイルを一緒に提出します。計測環境と同じ Ubuntu 26.04 x86_64 上で、次のようにビルドしてください。

```sh
cc -O2 -o main baselines/c/main.c
c++ -O2 -o main baselines/cpp/main.cpp
go build -o main ./baselines/go
rustc -O -o main baselines/rust/main.rs
zig build-exe -O ReleaseFast -femit-bin=main baselines/zig/main.zig
dotnet publish baselines/csharp/TraqBaseline.csproj -c Release -r linux-x64 -o publish
```

`dotnet publish` はNative AOTの単一実行ファイルを出力します。`publish/TraqBaseline` をNativeの実行ファイルとして選択してください。

すべての baseline は、コンテストと同じく `$ ./program input.csv output.txt` の形で実行できます。従来の `-i input.csv -o output.txt` もローカル検証用にサポートします。
