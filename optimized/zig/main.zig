const std = @import("std");
const posix = std.posix;
const Allocator = std.mem.Allocator;
const cap: usize = 1 << 15;
const year_start: u32 = 1798761600;
const month_start = [_]u32{ 1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000, 1814400000, 1817078400, 1819756800, 1822348800, 1825027200, 1827619200, 1830297600 };
const month_label = [_][]const u8{ "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12" };

const Stats = struct { total_len: u64 = 0, stamps: u64 = 0, messages: u32 = 0, min_len: u16 = 0, max_len: u16 = 0 };
const Agg = struct { month: [12]Stats = [_]Stats{.{}} ** 12 };
const Entry = struct { pos: usize = 0, len: u32 = 0, id: u16 = 0, tag: u16 = 0 };
const FlatMap = struct {
    entries: []Entry,
    aggs: []Agg,
    size: usize = 0,
    allocator: Allocator,
    fn init(a: Allocator) !FlatMap {
        const entries = try a.alloc(Entry, cap);
        @memset(entries, .{});
        const aggs = try a.alloc(Agg, cap / 2);
        @memset(aggs, .{});
        return .{ .entries = entries, .aggs = aggs, .allocator = a };
    }
    fn deinit(self: *FlatMap) void {
        self.allocator.free(self.entries);
        self.allocator.free(self.aggs);
    }
    fn find(self: *FlatMap, data: []const u8, key_pos: usize, len: u32, hash: u32) *Entry {
        var i: usize = @as(usize, @intCast(hash)) & (cap - 1);
        const tag: u16 = @intCast(hash >> 16);
        while (true) : (i = (i + 1) & (cap - 1)) {
            const e = &self.entries[i];
            if (e.len == 0) {
                e.* = .{ .pos = key_pos, .len = len, .id = @intCast(self.size), .tag = tag };
                self.size += 1;
                return e;
            }
            if (e.tag == tag and e.len == len and std.mem.eql(u8, data[e.pos..][0..len], data[key_pos..][0..len])) return e;
        }
    }
    fn add(self: *FlatMap, data: []const u8, key_pos: usize, len: u32, hash: u32, month: usize, ml: u32, stamps: u32) void {
        const e = self.find(data, key_pos, len, hash);
        const s = &self.aggs[e.id].month[month];
        if (s.messages == 0) s.* = .{ .messages = 1, .total_len = ml, .stamps = stamps, .min_len = @intCast(ml), .max_len = @intCast(ml) } else {
            s.messages += 1;
            s.total_len += ml;
            s.stamps += stamps;
            s.min_len = @min(s.min_len, @as(u16, @intCast(ml)));
            s.max_len = @max(s.max_len, @as(u16, @intCast(ml)));
        }
    }
    fn merge(self: *FlatMap, data: []const u8, other: *const FlatMap) void {
        for (other.entries) |src| {
            if (src.len == 0) continue;
            const e = self.find(data, src.pos, src.len, hashBytes(data[src.pos..][0..src.len]));
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
inline fn mix64(v: u64) u64 {
    var x = v;
    x ^= x >> 30;
    x *%= 0xbf58476d1ce4e5b9;
    x ^= x >> 27;
    x *%= 0x94d049bb133111eb;
    return x ^ (x >> 31);
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
    } else for (p, 0..) |x, i| a |= @as(u64, x) << @intCast(8 * i);
    return @truncate(mix64(a *% 0x9e3779b185ebca87 ^ std.math.rotl(u64, b, 21) ^ std.math.rotl(u64, c, 43) ^ @as(u64, n) *% 0xd6e8feb86659fd93));
}
inline fn timestamp(p: []const u8) u32 {
    var x = load64(p) & 0x0f0f0f0f0f0f0f0f;
    x = (x & 0x000f000f000f000f) * 10 + ((x >> 8) & 0x000f000f000f000f);
    x = (x & 0x000000ff000000ff) * 100 + ((x >> 16) & 0x000000ff000000ff);
    const first8: u32 = @as(u32, @truncate(x)) * 10000 + @as(u32, @truncate(x >> 32));
    return first8 * 100 + @as(u32, p[8] - '0') * 10 + p[9] - '0';
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
    while (p < w.end) {
        if (w.data[p] == '\n' or w.data[p] == '\r') {
            p += 1;
            continue;
        }
        const ts = timestamp(w.data[p..]);
        const month = w.months.*[(ts - year_start) / 86400];
        p += 11;
        const key = p;
        p += std.mem.indexOfScalar(u8, w.data[p..w.end], ',').?;
        const len: u32 = @intCast(p - key);
        const hash = hashBytes(w.data[key..p]);
        p += 1;
        var ml: u32 = w.data[p] - '0';
        p += 1;
        while (w.data[p] != ',') : (p += 1) ml = ml * 10 + w.data[p] - '0';
        p += 1;
        var stamps: u32 = w.data[p] - '0';
        p += 1;
        while (w.data[p] != '\n') : (p += 1) stamps = stamps * 10 + w.data[p] - '0';
        p += 1;
        map.add(w.data, key, len, hash, month, ml, stamps);
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
fn entryLess(data: []const u8, a: Entry, b: Entry) bool {
    return std.mem.order(u8, data[a.pos..][0..a.len], data[b.pos..][0..b.len]) == .lt;
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
fn writeResult(a: Allocator, writer: *std.Io.Writer, data: []const u8, map: *const FlatMap) !void {
    var entries = try a.alloc(Entry, map.size);
    defer a.free(entries);
    var n: usize = 0;
    for (map.entries) |e| if (e.len != 0) {
        entries[n] = e;
        n += 1;
    };
    std.mem.sort(Entry, entries, data, entryLess);
    for (entries) |e| for (0..12) |m| {
        const s = map.aggs[e.id].month[m];
        if (s.messages == 0) continue;
        try writer.print("{s},{s}={d}/", .{ data[e.pos..][0..e.len], month_label[m], s.min_len });
        try writeFixed2(writer, @as(f64, @floatFromInt(s.total_len)) / @as(f64, @floatFromInt(s.messages)));
        try writer.print("/{d}/{d}/{d}\n", .{ s.max_len, s.messages, s.stamps });
    };
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
    var merged = try FlatMap.init(std.heap.page_allocator);
    defer merged.deinit();
    var worker_sum: i128 = 0;
    for (workers) |*w| {
        worker_sum += w.elapsed_ns;
        merged.merge(data, &w.map.?);
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
    try writeResult(a, &stream.interface, data, &merged);
    try stream.interface.flush();
    const output_ns = std.time.nanoTimestamp() - output_start;
    if (o.profile) std.debug.print("profile mmap={d:.6} workers_wall={d:.6} workers_sum={d:.6} merge={d:.6} output={d:.6} total={d:.6} chunks={d} groups={d}\n", .{ @as(f64, @floatFromInt(mmap_ns)) / 1e9, @as(f64, @floatFromInt(worker_ns)) / 1e9, @as(f64, @floatFromInt(worker_sum)) / 1e9, @as(f64, @floatFromInt(merge_ns)) / 1e9, @as(f64, @floatFromInt(output_ns)) / 1e9, @as(f64, @floatFromInt(std.time.nanoTimestamp() - total)) / 1e9, o.threads, merged.groups() });
}
