const std = @import("std");

const ChannelStats = struct {
    min_len: i64,
    max_len: i64,
    total_len: i64,
    messages: i64,
    stamps: i64,
};

const Options = struct {
    input: ?[]const u8 = null,
    output: ?[]const u8 = null,
};

fn parseArgs(allocator: std.mem.Allocator) !Options {
    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();

    _ = args.next();
    var options = Options{};
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "-i")) {
            options.input = args.next() orelse return error.MissingArgument;
        } else if (std.mem.eql(u8, arg, "-o")) {
            options.output = args.next() orelse return error.MissingArgument;
        } else {
            return error.UnknownArgument;
        }
    }
    return options;
}

fn analyze(allocator: std.mem.Allocator, reader: *std.Io.Reader) !std.StringHashMap(ChannelStats) {
    var stats = std.StringHashMap(ChannelStats).init(allocator);
    errdefer {
        var it = stats.keyIterator();
        while (it.next()) |key| {
            allocator.free(key.*);
        }
        stats.deinit();
    }

    var line_number: usize = 0;

    if (try reader.takeDelimiter('\n')) |header_raw| {
        line_number += 1;
        const header_line = std.mem.trimRight(u8, header_raw, "\r");
        if (countFields(header_line) != 6) {
            return error.InvalidHeader;
        }
    } else {
        return error.MissingHeader;
    }

    while (try reader.takeDelimiter('\n')) |line_raw| {
        line_number += 1;
        const line = std.mem.trimRight(u8, line_raw, "\r");
        if (line.len == 0) {
            continue;
        }

        var fields: [6][]const u8 = undefined;
        if (!splitLine(line, &fields)) {
            return error.InvalidLine;
        }

        const channel_id = fields[3];
        const message_length = try std.fmt.parseInt(i64, fields[4], 10);
        const stamp_count = try std.fmt.parseInt(i64, fields[5], 10);

        if (stats.getPtr(channel_id)) |current| {
            if (message_length < current.min_len) {
                current.min_len = message_length;
            }
            if (message_length > current.max_len) {
                current.max_len = message_length;
            }
            current.total_len += message_length;
            current.messages += 1;
            current.stamps += stamp_count;
        } else {
            const owned_key = try allocator.dupe(u8, channel_id);
            try stats.put(owned_key, ChannelStats{
                .min_len = message_length,
                .max_len = message_length,
                .total_len = message_length,
                .messages = 1,
                .stamps = stamp_count,
            });
        }
    }

    return stats;
}

fn countFields(line: []const u8) usize {
    var count: usize = 1;
    for (line) |c| {
        if (c == ',') {
            count += 1;
        }
    }
    return count;
}

fn splitLine(line: []const u8, fields: *[6][]const u8) bool {
    var it = std.mem.splitScalar(u8, line, ',');
    var i: usize = 0;
    while (it.next()) |field| {
        if (i >= fields.len) {
            return false;
        }
        fields[i] = field;
        i += 1;
    }
    return i == fields.len;
}

fn stringLessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

fn writeResult(allocator: std.mem.Allocator, writer: *std.Io.Writer, stats: *std.StringHashMap(ChannelStats)) !void {
    var channel_ids = std.ArrayList([]const u8).empty;
    defer channel_ids.deinit(allocator);

    var it = stats.keyIterator();
    while (it.next()) |key| {
        try channel_ids.append(allocator, key.*);
    }
    std.mem.sort([]const u8, channel_ids.items, {}, stringLessThan);

    for (channel_ids.items) |channel_id| {
        const s = stats.get(channel_id).?;
        const mean_len = @as(f64, @floatFromInt(s.total_len)) / @as(f64, @floatFromInt(s.messages));
        try writer.print("{s}={d}/", .{ channel_id, s.min_len });
        try writeFixed2(writer, mean_len);
        try writer.print("/{d}/{d}/{d}\n", .{ s.max_len, s.messages, s.stamps });
    }
}

fn writeFixed2(writer: *std.Io.Writer, value: f64) !void {
    const bits: u64 = @bitCast(value);
    const exponent_bits: u64 = (bits >> 52) & 0x7ff;
    const fraction: u64 = bits & ((@as(u64, 1) << 52) - 1);

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
    if (exponent >= 0) {
        cents = scaled << @as(u7, @intCast(exponent));
    } else {
        const denominator = @as(u128, 1) << @as(u7, @intCast(-exponent));
        cents = scaled / denominator;
        const remainder = scaled % denominator;
        const twice = remainder * 2;
        if (twice > denominator or (twice == denominator and cents % 2 == 1)) {
            cents += 1;
        }
    }

    const whole = cents / 100;
    const decimal = cents % 100;
    if (decimal < 10) {
        try writer.print("{d}.0{d}", .{ whole, decimal });
    } else {
        try writer.print("{d}.{d}", .{ whole, decimal });
    }
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const options = try parseArgs(allocator);

    var input_file: ?std.fs.File = null;
    defer if (input_file) |file| file.close();
    var output_file: ?std.fs.File = null;
    defer if (output_file) |file| file.close();

    const input = if (options.input) |path| blk: {
        input_file = try std.fs.cwd().openFile(path, .{});
        break :blk input_file.?;
    } else std.fs.File.stdin();

    const output = if (options.output) |path| blk: {
        output_file = try std.fs.cwd().createFile(path, .{ .truncate = true });
        break :blk output_file.?;
    } else std.fs.File.stdout();

    var input_buffer: [4096]u8 = undefined;
    var input_reader = input.readerStreaming(&input_buffer);
    var output_buffer: [4096]u8 = undefined;
    var output_writer = output.writerStreaming(&output_buffer);

    var stats = try analyze(allocator, &input_reader.interface);
    defer {
        var it = stats.keyIterator();
        while (it.next()) |key| {
            allocator.free(key.*);
        }
        stats.deinit();
    }

    try writeResult(allocator, &output_writer.interface, &stats);
    try output_writer.interface.flush();
}
