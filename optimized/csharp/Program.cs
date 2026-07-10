using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Runtime.CompilerServices;

unsafe class Program
{
    const int Capacity = 1 << 15;
    const uint YearStart = 1798761600;
    static readonly uint[] MonthStart = [1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000, 1814400000, 1817078400, 1819756800, 1822348800, 1825027200, 1827619200, 1830297600];
    static readonly string[] MonthLabel = ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"];
    static readonly byte[] MonthByDay = MakeMonths();

    struct Stats { public ulong Messages, TotalLen, Stamps; public uint MinLen, MaxLen; }
    struct Entry { public long Pos; public ulong Hash; public int Len, Id; }
    sealed class FlatMap
    {
        public readonly Entry[] Entries = new Entry[Capacity];
        public readonly Stats[] Aggs = new Stats[(Capacity / 2) * 12];
        public int Size;
        int Find(nint data, long pos, int len, ulong hash)
        {
            int i = (int)hash & (Capacity - 1);
            for (; ; i = (i + 1) & (Capacity - 1))
            {
                ref Entry e = ref Entries[i];
                if (e.Len == 0) { e = new Entry { Pos = pos, Hash = hash, Len = len, Id = Size++ }; return i; }
                if (e.Hash == hash && e.Len == len && Equal((byte*)data + e.Pos, (byte*)data + pos, len)) return i;
            }
        }
        public void Add(nint data, long pos, int len, ulong hash, int month, uint ml, uint stamps)
        {
            int slot = Find(data, pos, len, hash); ref Stats s = ref Aggs[Entries[slot].Id * 12 + month];
            if (s.Messages == 0) s = new Stats { Messages = 1, TotalLen = ml, Stamps = stamps, MinLen = ml, MaxLen = ml };
            else { s.Messages++; s.TotalLen += ml; s.Stamps += stamps; if (ml < s.MinLen) s.MinLen = ml; if (ml > s.MaxLen) s.MaxLen = ml; }
        }
        public void Merge(nint data, FlatMap other)
        {
            foreach (ref readonly Entry a in other.Entries.AsSpan())
            {
                if (a.Len == 0) continue; int slot = Find(data, a.Pos, a.Len, a.Hash); int di = Entries[slot].Id * 12, si = a.Id * 12;
                for (int m = 0; m < 12; m++) { Stats x = other.Aggs[si + m]; if (x.Messages == 0) continue; ref Stats y = ref Aggs[di + m]; if (y.Messages == 0) y = x; else { y.Messages += x.Messages; y.TotalLen += x.TotalLen; y.Stamps += x.Stamps; if (x.MinLen < y.MinLen) y.MinLen = x.MinLen; if (x.MaxLen > y.MaxLen) y.MaxLen = x.MaxLen; } }
            }
        }
        public int Groups() { int n = 0; for (int i = 0; i < Size * 12; i++) if (Aggs[i].Messages != 0) n++; return n; }
    }
    sealed record Options(string Input, string Output, int Threads, bool Profile);
    static Options Parse(string[] args) { string input = "", output = ""; int threads = Environment.ProcessorCount; bool profile = false; for (int i = 0; i < args.Length; i++) { switch (args[i]) { case "-i": case "--input": input = args[++i]; break; case "-o": case "--output": output = args[++i]; break; case "-t": case "--threads": threads = int.Parse(args[++i], CultureInfo.InvariantCulture); break; case "--profile": profile = true; break; default: throw new Exception($"unknown argument: {args[i]}"); } } if (input.Length == 0 || threads < 1) throw new Exception("optimized C# analyzer requires -i and positive -t"); return new(input, output, threads, profile); }
    static byte[] MakeMonths() { byte[] a = new byte[365]; int m = 0; for (int d = 0; d < a.Length; d++) { uint ts = YearStart + (uint)d * 86400; if (ts >= MonthStart[m + 1]) m++; a[d] = (byte)m; } return a; }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static bool Equal(byte* a, byte* b, int len) { return new ReadOnlySpan<byte>(a, len).SequenceEqual(new ReadOnlySpan<byte>(b, len)); }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static ulong Mix(ulong x) { x ^= x >> 30; x *= 0xbf58476d1ce4e5b9UL; x ^= x >> 27; x *= 0x94d049bb133111ebUL; return x ^ (x >> 31); }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static ulong RotL(ulong x, int n) => (x << n) | (x >> (64 - n));
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static ulong Hash(byte* p, int n) { ulong a = 0, b = 0, c = 0; if (n >= 24) { a = Unsafe.ReadUnaligned<ulong>(p); b = Unsafe.ReadUnaligned<ulong>(p + n / 2 - 4); c = Unsafe.ReadUnaligned<ulong>(p + n - 8); } else if (n >= 8) { a = Unsafe.ReadUnaligned<ulong>(p); c = Unsafe.ReadUnaligned<ulong>(p + n - 8); } else for (int i = 0; i < n; i++) a |= (ulong)p[i] << (8 * i); return Mix(a * 0x9e3779b185ebca87UL ^ RotL(b, 21) ^ RotL(c, 43) ^ (ulong)n * 0xd6e8feb86659fd93UL); }
    [MethodImpl(MethodImplOptions.AggressiveInlining)] static uint Timestamp(byte* p) { uint x = (uint)(p[0] - '0'); x = x * 10 + (uint)(p[1] - '0'); x = x * 10 + (uint)(p[2] - '0'); x = x * 10 + (uint)(p[3] - '0'); x = x * 10 + (uint)(p[4] - '0'); x = x * 10 + (uint)(p[5] - '0'); x = x * 10 + (uint)(p[6] - '0'); x = x * 10 + (uint)(p[7] - '0'); x = x * 10 + (uint)(p[8] - '0'); x = x * 10 + (uint)(p[9] - '0'); return x; }
    static FlatMap Analyze(nint data, long begin, long end)
    {
        var map = new FlatMap(); byte* d = (byte*)data; long p = begin;
        while (p < end) { if (d[p] == '\n' || d[p] == '\r') { p++; continue; } uint ts = Timestamp(d + p); int month = MonthByDay[(ts - YearStart) / 86400]; p += 11; long key = p; while (d[p] != ',') p++; int len = (int)(p - key); ulong hash = Hash(d + key, len); p++; uint ml = 0; while (d[p] != ',') ml = ml * 10 + (uint)(d[p++] - '0'); p++; uint stamps = 0; while (p < end && (uint)(d[p] - '0') <= 9) stamps = stamps * 10 + (uint)(d[p++] - '0'); while (p < end && d[p] != '\n') p++; if (p < end) p++; map.Add(data, key, len, hash, month, ml, stamps); }
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
        try { var o = Parse(args); var total = Stopwatch.StartNew(); var watch = Stopwatch.StartNew(); using var file = File.OpenRead(o.Input); using var mmf = MemoryMappedFile.CreateFromFile(file, null, 0, MemoryMappedFileAccess.Read, HandleInheritability.None, false); using var view = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read); byte* acquired = null; view.SafeMemoryMappedViewHandle.AcquirePointer(ref acquired); try { nint data = (nint)(acquired + view.PointerOffset); long length = file.Length; double mmap = watch.Elapsed.TotalSeconds; byte* d = (byte*)data; ReadOnlySpan<byte> header = "unix_timestamp,channel_path,message_length,stamp_count\n"u8; if (length < header.Length || !new ReadOnlySpan<byte>(d, header.Length).SequenceEqual(header)) throw new Exception("unsupported CSV header"); long begin = header.Length; var chunks = new (long, long)[o.Threads]; long start = begin; for (int i = 0; i < o.Threads; i++) { long stop = i + 1 == o.Threads ? length : FindNewline(d, begin + (length - begin) * (i + 1) / o.Threads, length); chunks[i] = (start, stop); start = stop; } var maps = new FlatMap[o.Threads]; var elapsed = new double[o.Threads]; watch.Restart(); Parallel.For(0, o.Threads, new ParallelOptions { MaxDegreeOfParallelism = o.Threads }, i => { var w = Stopwatch.StartNew(); maps[i] = Analyze(data, chunks[i].Item1, chunks[i].Item2); elapsed[i] = w.Elapsed.TotalSeconds; }); double workerWall = watch.Elapsed.TotalSeconds; watch.Restart(); var merged = new FlatMap(); foreach (var m in maps) merged.Merge(data, m); double merge = watch.Elapsed.TotalSeconds; using Stream output = o.Output.Length == 0 ? Console.OpenStandardOutput() : new FileStream(o.Output, FileMode.Create, FileAccess.Write, FileShare.Read); watch.Restart(); WriteResult(output, data, merged); double outputTime = watch.Elapsed.TotalSeconds; if (o.Profile) Console.Error.WriteLine(FormattableString.Invariant($"profile mmap={mmap:F6} workers_wall={workerWall:F6} workers_sum={elapsed.Sum():F6} merge={merge:F6} output={outputTime:F6} total={total.Elapsed.TotalSeconds:F6} chunks={o.Threads} groups={merged.Groups()}")); } finally { view.SafeMemoryMappedViewHandle.ReleasePointer(); } return 0; } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
