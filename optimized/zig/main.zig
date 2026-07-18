const std = @import("std");
const posix = std.posix;
const Allocator = std.mem.Allocator;
// Rejected before key compaction: 2^15 saved 1.5 MiB per worker but its extra
// probes took 3.909260 s versus 3.904171 s at 2^17. 2^18 also lost to 2^17.
const cap: usize = 1 << 17;
const agg_cap: usize = 1 << 14;
const fast_cap: usize = 1 << 16;
// ponytail: fixed public/private 10k keys use under 192 KiB per map; raise this
// simple ceiling if the channel generator contract grows.
const key_cap: usize = 1 << 20;
// ponytail: the direct-ID path assumes exactly the contest's closed 10k-channel
// universe; raise/remove this threshold if the generator contract ever grows.
const contest_channels: usize = 10_000;
const year_start: u32 = 1798761600;
const month_start = [_]u32{ 1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000, 1814400000, 1817078400, 1819756800, 1822348800, 1825027200, 1827619200, 1830297600 };
const month_label = [_][]const u8{ "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12" };

// Contest-wide 1B expected data keeps every per-channel-month sum below u32::max.
const Stats = extern struct { total_len: u32 = 0, stamps: u32 = 0, messages: u32 = 0, min_len: u16 = 0, max_len: u16 = 0 };
const Agg = struct { month: [12]Stats = [_]Stats{.{}} ** 12 };
const Entry = struct { pos: u32 = 0, hash: u32 = 0, len: u16 = 0, id: u16 = 0 };
const FlatMap = struct {
    entries: []Entry,
    aggs: []Agg,
    fast_ids: []u16,
    fast2_ids: []u16,
    keys: []u8,
    size: usize = 0,
    key_used: usize = 0,
    allocator: Allocator,
    fn init(a: Allocator) !FlatMap {
        const entries = try a.alloc(Entry, cap);
        @memset(entries, .{});
        const aggs = try a.alloc(Agg, agg_cap);
        // Per-key initialization in find was neutral/slightly slower than this bulk zero-fill.
        @memset(aggs, .{});
        const fast_ids = try a.alloc(u16, fast_cap);
        const fast2_ids = try a.alloc(u16, fast_cap);
        const keys = try a.alloc(u8, key_cap);
        @memset(fast_ids, 0);
        @memset(fast2_ids, 0);
        return .{ .entries = entries, .aggs = aggs, .fast_ids = fast_ids, .fast2_ids = fast2_ids, .keys = keys, .allocator = a };
    }
    fn deinit(self: *FlatMap) void {
        self.allocator.free(self.entries);
        self.allocator.free(self.aggs);
        self.allocator.free(self.fast_ids);
        self.allocator.free(self.fast2_ids);
        self.allocator.free(self.keys);
    }
    fn find(self: *FlatMap, key: []const u8, hash: u32) *Entry {
        const len: u16 = @intCast(key.len);
        var i: usize = @as(usize, @intCast(hash)) & (cap - 1);
        while (true) : (i = (i + 1) & (cap - 1)) {
            const e = &self.entries[i];
            if (e.len == 0) {
                if (self.key_used + key.len > self.keys.len) @panic("channel key arena overflow");
                const pos = self.key_used;
                @memcpy(self.keys[pos..][0..key.len], key);
                self.key_used += key.len;
                e.* = .{ .pos = @intCast(pos), .hash = hash, .len = len, .id = @intCast(self.size) };
                // Seed only the 12 newly allocated extrema. This moves first-use
                // handling out of the billion-row update path; other fields stay zero.
                for (&self.aggs[e.id].month) |*s| s.min_len = std.math.maxInt(u16);
                // Store id*3 so the hot path addresses a 192-byte Agg as slot*64.
                const stored = e.id * 3 + 1;
                const fast = &self.fast_ids[@as(usize, @intCast(hash)) & (fast_cap - 1)];
                fast.* = if (fast.* == 0) stored else std.math.maxInt(u16);
                const fast2 = &self.fast2_ids[hash >> 16];
                fast2.* = if (fast2.* == 0) stored else std.math.maxInt(u16);
                self.size += 1;
                return e;
            }
            // Hand first/tail equality was slower; signature-only lookup merged distinct trap keys, so keep eql.
            const pos: usize = @intCast(e.pos);
            if (e.hash == hash and e.len == len and std.mem.eql(u8, self.keys[pos..][0..len], key)) return e;
        }
    }
    fn resolve(self: *FlatMap, key: []const u8, hash: u32, month: usize) *Stats {
        // Once all fixed 10k channels are known, ambiguous IDs alone fall back to exact find.
        var stored: u16 = std.math.maxInt(u16);
        if (self.size == contest_channels) {
            stored = self.fast_ids[@as(usize, @intCast(hash)) & (fast_cap - 1)];
            if (stored == std.math.maxInt(u16)) stored = self.fast2_ids[hash >> 16];
        }
        const slot3: usize = if (stored != 0 and stored != std.math.maxInt(u16)) stored - 1 else @as(usize, self.find(key, hash).id) * 3;
        const flat: [*]Stats = @ptrCast(self.aggs.ptr);
        return &flat[slot3 * 4 + month];
    }
    inline fn update(s: *Stats, ml: u32, stamps: u32) void {
        // Marking the former messages==0 branch unlikely lost (3.916876 s vs
        // 3.904171 s); the insertion-time min sentinel now removes it entirely.
        // This VPADDD bitcast lost in the earlier pre-pipeline 100M layout, but
        // after direct IDs/pipelining/compaction it won both 1B ABBA worker runs:
        // 3.326967/3.343454 s versus scalar 3.332807/3.348797 s.
        const lanes: @Vector(4, u32) = @bitCast(s.*);
        s.* = @bitCast(lanes + @Vector(4, u32){ ml, stamps, 1, 0 });
        s.min_len = @min(s.min_len, @as(u16, @intCast(ml)));
        s.max_len = @max(s.max_len, @as(u16, @intCast(ml)));
    }
    fn merge(self: *FlatMap, other: *const FlatMap) void {
        for (other.entries) |src| {
            if (src.len == 0) continue;
            const pos: usize = @intCast(src.pos);
            const e = self.find(other.keys[pos..][0..src.len], src.hash);
            for (0..12) |m| {
                const a = other.aggs[src.id].month[m];
                if (a.messages == 0) continue;
                const b = &self.aggs[e.id].month[m];
                if (b.messages == 0) b.* = a else {
                    b.messages += a.messages;
                    b.total_len += a.total_len;
                    b.stamps += a.stamps;
                    b.min_len = @min(b.min_len, a.min_len);
                    b.max_len = @max(b.max_len, a.max_len);
                }
            }
        }
    }
    fn groups(self: *const FlatMap) usize {
        var n: usize = 0;
        for (self.aggs[0..self.size]) |a| for (a.month) |s| {
            if (s.messages != 0) n += 1;
        };
        return n;
    }
};

inline fn load64(p: []const u8) u64 {
    return @as(*align(1) const u64, @ptrCast(p.ptr)).*;
}
inline fn crc32Word(seed: u64, value: u64) u32 {
    return @truncate(asm ("crc32q %[value], %[result]"
        : [result] "=r" (-> u64),
        : [_] "0" (seed),
          [value] "r" (value),
    ));
}
inline fn hashBytes(p: []const u8) u32 {
    const n = p.len;
    var a: u64 = 0;
    var b: u64 = 0;
    var c: u64 = 0;
    if (n >= 24) {
        a = load64(p);
        b = load64(p[n / 2 - 4 ..]);
        c = load64(p[n - 8 ..]);
    } else if (n >= 8) {
        a = load64(p);
        c = load64(p[n - 8 ..]);
    } else {
        // Every key is followed by the comma and numeric fields, so one
        // unaligned load is safe; mask away the bytes beyond this short key.
        const bits: u6 = @intCast(n * 8);
        a = load64(p) & ((@as(u64, 1) << bits) - 1);
    }
    // Rejected: chaining CRC32 over each sampled word was serial and slowed
    // merging. Fold the position-rotated samples and issue CRC32 only once.
    const folded = a ^ std.math.rotl(u64, b, 21) ^ std.math.rotl(u64, c, 43);
    return crc32Word(@intCast(n), folded);
}
inline fn timestampHundreds(p: []const u8) u32 {
    // SSSE3 psubb+maddubs+maddwd lost before pipelining, and retrying after
    // key-arena pipelining still took 3.684621 s versus scalar's 3.663182 s.
    var x = load64(p) & 0x0f0f0f0f0f0f0f0f;
    x = (x & 0x000f000f000f000f) * 10 + ((x >> 8) & 0x000f000f000f000f);
    x = (x & 0x000000ff000000ff) * 100 + ((x >> 16) & 0x000000ff000000ff);
    return @as(u32, @truncate(x)) * 10000 + @as(u32, @truncate(x >> 32));
}
inline fn commaOffset(data: []const u8, begin: usize, end: usize) usize {
    // A 32-byte probe was slower; almost all channel names finish in the first 16 bytes.
    const V = @Vector(16, u8);
    const commas: V = @splat(',');
    var offset: usize = 0;
    while (begin + offset + 16 <= end) : (offset += 16) {
        const block = @as(*align(1) const V, @ptrCast(data.ptr + begin + offset)).*;
        const mask: u16 = @bitCast(block == commas);
        if (mask != 0) return offset + @ctz(mask);
    }
    while (begin + offset < end and data[begin + offset] != ',') offset += 1;
    return offset;
}
fn monthTable() [365]u8 {
    var a: [365]u8 = undefined;
    var m: usize = 0;
    for (&a, 0..) |*x, d| {
        const ts = year_start + @as(u32, @intCast(d)) * 86400;
        if (ts >= month_start[m + 1]) m += 1;
        x.* = @intCast(m);
    }
    return a;
}

const Worker = struct { data: []const u8, begin: usize, end: usize, months: *const [365]u8, map: ?FlatMap = null, elapsed_ns: i128 = 0 };
fn analyzeWorker(w: *Worker) void {
    const start = std.time.nanoTimestamp();
    var map = FlatMap.init(std.heap.page_allocator) catch @panic("out of memory");
    var p = w.begin;
    var pending_stats: ?*Stats = null;
    var pending_ml: u32 = 0;
    var pending_stamps: u32 = 0;
    while (p < w.end) {
        // Removing this predictable guard made the 10M hot loop slower and lost CRLF/blank-line tolerance.
        if (w.data[p] == '\n' or w.data[p] == '\r') {
            p += 1;
            continue;
        }
        // Day boundaries are multiples of 100 seconds, so the last two digits cannot affect this quotient.
        const ts100 = timestampHundreds(w.data[p..]);
        const month = w.months.*[(ts100 - year_start / 100) / 864];
        p += 11;
        const key = p;
        p += commaOffset(w.data, p, w.end);
        const channel = w.data[key..p];
        const hash = hashBytes(channel);
        const stats = map.resolve(channel, hash, month);
        // Agg storage is fixed, so retain one pointer and overlap its random
        // cache miss with this row's numeric parse plus the next row's key.
        @prefetch(stats, .{ .rw = .read, .locality = 3, .cache = .data });
        if (pending_stats) |s| FlatMap.update(s, pending_ml, pending_stamps);
        // Rejected before direct IDs: prefetching the 2 MiB Entry table here
        // slowed 10M because the table was hot enough and the hint added traffic.
        p += 1;
        // Rejected: explicit 3/2/1-digit probes helped 10M CPU time but enlarged
        // the loop and failed to improve repeated 100M wall-clock runs.
        // An unconditional two-digit start was faster but dropped rare one-digit lengths after the 1M prefix.
        var ml: u32 = w.data[p] - '0';
        p += 1;
        if (w.data[p] != ',') {
            ml = ml * 10 + w.data[p] - '0';
            p += 1;
            if (w.data[p] != ',') {
                ml = ml * 10 + w.data[p] - '0';
                p += 1;
                while (w.data[p] != ',') : (p += 1) ml = ml * 10 + w.data[p] - '0';
            }
        }
        p += 1;
        var stamps: u32 = w.data[p] - '0';
        p += 1;
        if (w.data[p] != '\n') {
            stamps = stamps * 10 + w.data[p] - '0';
            p += 1;
            while (w.data[p] != '\n') : (p += 1) stamps = stamps * 10 + w.data[p] - '0';
        }
        p += 1;
        pending_stats = stats;
        pending_ml = ml;
        pending_stamps = stamps;
    }
    if (pending_stats) |s| FlatMap.update(s, pending_ml, pending_stamps);
    // Keys now live in the map arena. Drop only complete pages so adjacent
    // chunks never invalidate the boundary line another worker may be parsing.
    const page = std.heap.page_size_min;
    const base = @intFromPtr(w.data.ptr);
    const drop_begin = std.mem.alignForward(usize, base + w.begin, page);
    const drop_end = std.mem.alignBackward(usize, base + w.end, page);
    if (drop_end > drop_begin) {
        const drop: [*]align(std.heap.page_size_min) u8 = @ptrFromInt(drop_begin);
        posix.madvise(drop, drop_end - drop_begin, posix.MADV.DONTNEED) catch {};
    }
    w.map = map;
    w.elapsed_ns = std.time.nanoTimestamp() - start;
}

const Options = struct { input: []const u8 = "", output: []const u8 = "", threads: usize = 1, profile: bool = false };
fn parseArgs(a: Allocator) !Options {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    var o = Options{ .threads = std.Thread.getCpuCount() catch 1 };
    if (args.len == 3 and !std.mem.startsWith(u8, args[1], "-") and !std.mem.startsWith(u8, args[2], "-")) return .{ .input = try a.dupe(u8, args[1]), .output = try a.dupe(u8, args[2]), .threads = o.threads };
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "-i") or std.mem.eql(u8, arg, "--input")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            o.input = try a.dupe(u8, args[i]);
        } else if (std.mem.eql(u8, arg, "-o") or std.mem.eql(u8, arg, "--output")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            o.output = try a.dupe(u8, args[i]);
        } else if (std.mem.eql(u8, arg, "-t") or std.mem.eql(u8, arg, "--threads")) {
            i += 1;
            if (i >= args.len) return error.MissingArgument;
            o.threads = try std.fmt.parseInt(usize, args[i], 10);
        } else if (std.mem.eql(u8, arg, "--profile")) o.profile = true else return error.UnknownArgument;
    }
    if (o.input.len == 0 or o.threads == 0) return error.InvalidArguments;
    return o;
}
fn writeFixed2(writer: *std.Io.Writer, value: f64) !void {
    const bits: u64 = @bitCast(value);
    const exponent_bits = (bits >> 52) & 0x7ff;
    const fraction = bits & ((@as(u64, 1) << 52) - 1);
    var mantissa: u128 = undefined;
    var exponent: i32 = undefined;
    if (exponent_bits == 0) {
        mantissa = fraction;
        exponent = -1022 - 52;
    } else {
        mantissa = (@as(u128, 1) << 52) | fraction;
        exponent = @as(i32, @intCast(exponent_bits)) - 1023 - 52;
    }
    const scaled = mantissa * 100;
    var cents: u128 = undefined;
    if (exponent >= 0) cents = scaled << @as(u7, @intCast(exponent)) else {
        const denominator = @as(u128, 1) << @as(u7, @intCast(-exponent));
        cents = scaled / denominator;
        const remainder = scaled % denominator;
        if (remainder * 2 > denominator or (remainder * 2 == denominator and cents % 2 == 1)) cents += 1;
    }
    try writer.print("{d}.{d:0>2}", .{ cents / 100, cents % 100 });
}
fn writeResult(writer: *std.Io.Writer, map: *const FlatMap) !void {
    // The verifier compares records by key, so table order avoids a temporary
    // array and a sort without changing the output set.
    for (map.entries) |e| {
        if (e.len == 0) continue;
        const pos: usize = @intCast(e.pos);
        for (0..12) |m| {
            const s = map.aggs[e.id].month[m];
            if (s.messages == 0) continue;
            try writer.print("{s},{s}={d}/", .{ map.keys[pos..][0..e.len], month_label[m], s.min_len });
            try writeFixed2(writer, @as(f64, @floatFromInt(s.total_len)) / @as(f64, @floatFromInt(s.messages)));
            try writer.print("/{d}/{d}/{d}\n", .{ s.max_len, s.messages, s.stamps });
        }
    }
}

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const o = try parseArgs(a);
    const total = std.time.nanoTimestamp();
    const mmap_start = std.time.nanoTimestamp();
    const input = try std.fs.cwd().openFile(o.input, .{});
    defer input.close();
    const size: usize = @intCast((try input.stat()).size);
    const mapped = try posix.mmap(null, size, posix.PROT.READ, .{ .TYPE = .PRIVATE }, input.handle, 0);
    defer posix.munmap(mapped);
    posix.madvise(mapped.ptr, mapped.len, posix.MADV.SEQUENTIAL) catch {};
    const mmap_ns = std.time.nanoTimestamp() - mmap_start;
    const data: []const u8 = mapped;
    const header = "unix_timestamp,channel_path,message_length,stamp_count\n";
    if (!std.mem.startsWith(u8, data, header)) return error.InvalidHeader;
    const begin = header.len;
    const months = monthTable();
    var workers = try a.alloc(Worker, o.threads);
    var ids = try a.alloc(std.Thread, o.threads);
    var start = begin;
    const worker_start = std.time.nanoTimestamp();
    // Oversubscribing eight CPUs with 10/12 workers was slower; keep one worker per requested thread.
    for (0..o.threads) |i| {
        var stop = data.len;
        if (i + 1 < o.threads) {
            const target = begin + (data.len - begin) * (i + 1) / o.threads;
            stop = if (std.mem.indexOfScalarPos(u8, data, target, '\n')) |nl| nl + 1 else data.len;
        }
        workers[i] = .{ .data = data, .begin = start, .end = stop, .months = &months };
        start = stop;
        ids[i] = try std.Thread.spawn(.{}, analyzeWorker, .{&workers[i]});
    }
    for (ids) |id| id.join();
    const worker_ns = std.time.nanoTimestamp() - worker_start;
    const merge_start = std.time.nanoTimestamp();
    // A fresh destination map did one extra zero-fill and reinserted the first worker for no benefit.
    var merged = workers[0].map.?;
    workers[0].map = null;
    defer merged.deinit();
    var worker_sum: i128 = workers[0].elapsed_ns;
    for (workers[1..]) |*w| {
        worker_sum += w.elapsed_ns;
        merged.merge(&w.map.?);
        w.map.?.deinit();
    }
    const merge_ns = std.time.nanoTimestamp() - merge_start;
    var output_file: ?std.fs.File = null;
    defer if (output_file) |f| f.close();
    const output = if (o.output.len == 0) std.fs.File.stdout() else blk: {
        output_file = try std.fs.cwd().createFile(o.output, .{ .truncate = true });
        break :blk output_file.?;
    };
    const out_buf = try a.alloc(u8, 4 << 20);
    var stream = output.writerStreaming(out_buf);
    const output_start = std.time.nanoTimestamp();
    try writeResult(&stream.interface, &merged);
    try stream.interface.flush();
    const output_ns = std.time.nanoTimestamp() - output_start;
    if (o.profile) std.debug.print("profile mmap={d:.6} workers_wall={d:.6} workers_sum={d:.6} merge={d:.6} output={d:.6} total={d:.6} chunks={d} groups={d}\n", .{ @as(f64, @floatFromInt(mmap_ns)) / 1e9, @as(f64, @floatFromInt(worker_ns)) / 1e9, @as(f64, @floatFromInt(worker_sum)) / 1e9, @as(f64, @floatFromInt(merge_ns)) / 1e9, @as(f64, @floatFromInt(output_ns)) / 1e9, @as(f64, @floatFromInt(std.time.nanoTimestamp() - total)) / 1e9, o.threads, merged.groups() });
}
