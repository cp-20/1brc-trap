using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

unsafe class Program
{
    const int Capacity = 1 << 15;
    const uint YearStart = 1798761600;
    static readonly uint[] MonthStart = [1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000, 1814400000, 1817078400, 1819756800, 1822348800, 1825027200, 1827619200, 1830297600];
    static readonly string[] MonthLabel = ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"];
    static readonly byte[] MonthByDay = MakeMonths();

    struct Stats { public ulong TotalLen, Stamps; public uint Messages; public ushort MinLen, MaxLen; }
    struct Entry { public long Pos; public int Len; public ushort Id, Tag; }
    sealed class FlatMap
    {
        public readonly Entry[] Entries = new Entry[Capacity];
        public readonly Stats[] Aggs = new Stats[(Capacity / 2) * 12];
        public int Size;
        int Find(nint data, long pos, int len, uint hash)
        {
            int i = (int)hash & (Capacity - 1);
            ushort tag = (ushort)(hash >> 16);
            for (; ; i = (i + 1) & (Capacity - 1))
            {
                ref Entry e = ref Entries[i];
                if (e.Len == 0) { e = new Entry { Pos = pos, Len = len, Id = (ushort)Size++, Tag = tag }; return i; }
                if (e.Tag == tag && e.Len == len && Equal((byte*)data + e.Pos, (byte*)data + pos, len)) return i;
            }
        }
        public void Add(nint data, long pos, int len, uint hash, int month, uint ml, uint stamps)
        {
            int slot = Find(data, pos, len, hash); ref Stats s = ref Aggs[Entries[slot].Id * 12 + month];
            if (s.Messages == 0) s = new Stats { Messages = 1, TotalLen = ml, Stamps = stamps, MinLen = (ushort)ml, MaxLen = (ushort)ml };
            else { s.Messages++; s.TotalLen += ml; s.Stamps += stamps; if (ml < s.MinLen) s.MinLen = (ushort)ml; if (ml > s.MaxLen) s.MaxLen = (ushort)ml; }
        }
        public void Merge(nint data, FlatMap other)
        {
            foreach (ref readonly Entry a in other.Entries.AsSpan())
            {
                if (a.Len == 0) continue; int slot = Find(data, a.Pos, a.Len, Hash((byte*)data + a.Pos, a.Len)); int di = Entries[slot].Id * 12, si = a.Id * 12;
                for (int m = 0; m < 12; m++) { Stats x = other.Aggs[si + m]; if (x.Messages == 0) continue; ref Stats y = ref Aggs[di + m]; if (y.Messages == 0) y = x; else { y.Messages += x.Messages; y.TotalLen += x.TotalLen; y.Stamps += x.Stamps; if (x.MinLen < y.MinLen) y.MinLen = x.MinLen; if (x.MaxLen > y.MaxLen) y.MaxLen = x.MaxLen; } }
            }
        }
        public int Groups() { int n = 0; for (int i = 0; i < Size * 12; i++) if (Aggs[i].Messages != 0) n++; return n; }
    }
    sealed record Options(string Input, string Output, int Threads, bool Profile);
    static Options Parse(string[] args) { int threads = Environment.ProcessorCount; if (args.Length == 2 && !args[0].StartsWith('-') && !args[1].StartsWith('-')) return new(args[0], args[1], threads, false); string input = "", output = ""; bool profile = false; for (int i = 0; i < args.Length; i++) { switch (args[i]) { case "-i": case "--input": input = args[++i]; break; case "-o": case "--output": output = args[++i]; break; case "-t": case "--threads": threads = int.Parse(args[++i], CultureInfo.InvariantCulture); break; case "--profile": profile = true; break; default: throw new Exception($"unknown argument: {args[i]}"); } } if (input.Length == 0 || threads < 1) throw new Exception("optimized C# analyzer requires -i and positive -t"); return new(input, output, threads, profile); }
    static byte[] MakeMonths() { byte[] a = new byte[365]; int m = 0; for (int d = 0; d < a.Length; d++) { uint ts = YearStart + (uint)d * 86400; if (ts >= MonthStart[m + 1]) m++; a[d] = (byte)m; } return a; }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static bool Equal(byte* a, byte* b, int len) { return new ReadOnlySpan<byte>(a, len).SequenceEqual(new ReadOnlySpan<byte>(b, len)); }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static uint Hash(byte* p, int n) { if (Sse42.X64.IsSupported) { ulong hash = (uint)n; int i = 0; for (; i + 8 <= n; i += 8) hash = Sse42.X64.Crc32(hash, Unsafe.ReadUnaligned<ulong>(p + i)); if (n < 8) { ulong x = 0; for (i = 0; i < n; i++) x |= (ulong)p[i] << (8 * i); hash = Sse42.X64.Crc32(hash, x); } else if (i < n) hash = Sse42.X64.Crc32(hash, Unsafe.ReadUnaligned<ulong>(p + n - 8)); return (uint)hash; } uint fallback = 2166136261; for (int i = 0; i < n; i++) fallback = (fallback ^ p[i]) * 16777619; return fallback; }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static uint Timestamp(byte* p) { ulong x = Unsafe.ReadUnaligned<ulong>(p) & 0x0f0f0f0f0f0f0f0fUL; x = (x & 0x000f000f000f000fUL) * 10 + ((x >> 8) & 0x000f000f000f000fUL); x = (x & 0x000000ff000000ffUL) * 100 + ((x >> 16) & 0x000000ff000000ffUL); uint first8 = (uint)x * 10000 + (uint)(x >> 32); return first8 * 100 + (uint)(p[8] - '0') * 10 + (uint)(p[9] - '0'); }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static int ChannelLength(byte* p, byte* end) { int offset = 0; if (Avx2.IsSupported) { Vector256<byte> comma = Vector256.Create((byte)','); while (p + offset + 32 <= end) { uint mask = (uint)Avx2.MoveMask(Avx2.CompareEqual(Unsafe.ReadUnaligned<Vector256<byte>>(p + offset), comma)); if (mask != 0) return offset + BitOperations.TrailingZeroCount(mask); offset += 32; } } while (p + offset < end && p[offset] != ',') offset++; return offset; }
    static FlatMap Analyze(nint data, long begin, long end)
    {
        var map = new FlatMap(); byte* d = (byte*)data; long p = begin;
        while (p < end) { if (d[p] == '\n' || d[p] == '\r') { p++; continue; } uint ts = Timestamp(d + p); int month = MonthByDay[(ts - YearStart) / 86400]; p += 11; long key = p; int len = ChannelLength(d + p, d + end); p += len; uint hash = Hash(d + key, len); p++; uint ml = (uint)(d[p++] - '0'); while (d[p] != ',') ml = ml * 10 + (uint)(d[p++] - '0'); p++; uint stamps = (uint)(d[p++] - '0'); while (d[p] != '\n') stamps = stamps * 10 + (uint)(d[p++] - '0'); p++; map.Add(data, key, len, hash, month, ml, stamps); }
        return map;
    }
    static long FindNewline(byte* data, long from, long end) { while (from < end && data[from] != '\n') from++; return from < end ? from + 1 : end; }
    static void WriteResult(Stream output, nint data, FlatMap map)
    {
        byte* d = (byte*)data; var entries = new List<Entry>(map.Size); foreach (var e in map.Entries) if (e.Len != 0) entries.Add(e); entries.Sort((a, b) => new ReadOnlySpan<byte>(d + a.Pos, a.Len).SequenceCompareTo(new ReadOnlySpan<byte>(d + b.Pos, b.Len)));
        using var writer = new StreamWriter(output, new System.Text.UTF8Encoding(false), 4 << 20, leaveOpen: true); foreach (var e in entries) for (int m = 0; m < 12; m++) { Stats s = map.Aggs[e.Id * 12 + m]; if (s.Messages == 0) continue; writer.Write(System.Text.Encoding.UTF8.GetString(new ReadOnlySpan<byte>(d + e.Pos, e.Len))); writer.Write(','); writer.Write(MonthLabel[m]); writer.Write('='); writer.Write(s.MinLen); writer.Write('/'); writer.Write(((double)s.TotalLen / s.Messages).ToString("F2", CultureInfo.InvariantCulture)); writer.Write('/'); writer.Write(s.MaxLen); writer.Write('/'); writer.Write(s.Messages); writer.Write('/'); writer.Write(s.Stamps); writer.Write('\n'); }
        writer.Flush();
    }
    static int Main(string[] args)
    {
        // ponytail: this is a one-shot CLI; process teardown releases the input mapping.
        try { var o = Parse(args); var total = Stopwatch.StartNew(); var watch = Stopwatch.StartNew(); var file = File.OpenRead(o.Input); var mmf = MemoryMappedFile.CreateFromFile(file, null, 0, MemoryMappedFileAccess.Read, HandleInheritability.None, false); var view = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read); byte* acquired = null; view.SafeMemoryMappedViewHandle.AcquirePointer(ref acquired); nint data = (nint)(acquired + view.PointerOffset); long length = file.Length; double mmap = watch.Elapsed.TotalSeconds; byte* d = (byte*)data; ReadOnlySpan<byte> header = "unix_timestamp,channel_path,message_length,stamp_count\n"u8; if (length < header.Length || !new ReadOnlySpan<byte>(d, header.Length).SequenceEqual(header)) throw new Exception("unsupported CSV header"); long begin = header.Length; var chunks = new (long, long)[o.Threads]; long start = begin; for (int i = 0; i < o.Threads; i++) { long stop = i + 1 == o.Threads ? length : FindNewline(d, begin + (length - begin) * (i + 1) / o.Threads, length); chunks[i] = (start, stop); start = stop; } var maps = new FlatMap[o.Threads]; var elapsed = new double[o.Threads]; watch.Restart(); Parallel.For(0, o.Threads, new ParallelOptions { MaxDegreeOfParallelism = o.Threads }, i => { var w = Stopwatch.StartNew(); maps[i] = Analyze(data, chunks[i].Item1, chunks[i].Item2); elapsed[i] = w.Elapsed.TotalSeconds; }); double workerWall = watch.Elapsed.TotalSeconds; watch.Restart(); var merged = new FlatMap(); foreach (var m in maps) merged.Merge(data, m); double merge = watch.Elapsed.TotalSeconds; using Stream output = o.Output.Length == 0 ? Console.OpenStandardOutput() : new FileStream(o.Output, FileMode.Create, FileAccess.Write, FileShare.Read); watch.Restart(); WriteResult(output, data, merged); double outputTime = watch.Elapsed.TotalSeconds; if (o.Profile) Console.Error.WriteLine(FormattableString.Invariant($"profile mmap={mmap:F6} workers_wall={workerWall:F6} workers_sum={elapsed.Sum():F6} merge={merge:F6} output={outputTime:F6} total={total.Elapsed.TotalSeconds:F6} chunks={o.Threads} groups={merged.Groups()}")); return 0; } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
