#!/usr/bin/env ruby
# frozen_string_literal: true

YEAR_START = 1_798_761_600
MONTH_START = [1_798_761_600,1_801_440_000,1_803_859_200,1_806_537_600,1_809_129_600,1_811_808_000,1_814_400_000,1_817_078_400,1_819_756_800,1_822_348_800,1_825_027_200,1_827_619_200,1_830_297_600].freeze
MONTH_LABEL = %w[2027-01 2027-02 2027-03 2027-04 2027-05 2027-06 2027-07 2027-08 2027-09 2027-10 2027-11 2027-12].freeze
MONTH_BY_DAY = Array.new(365) { |d| MONTH_START.bsearch_index { |x| x > YEAR_START + d * 86_400 } - 1 }.freeze

def options(argv)
  o = { input: nil, output: nil, threads: Etc.nprocessors, profile: false }
  return o.merge(input: argv[0], output: argv[1]) if argv.length == 2 && argv.none? { |arg| arg.start_with?("-") }

  i = 0
  while i < argv.length
    case argv[i]
    when "-i", "--input" then o[:input] = argv[i += 1]
    when "-o", "--output" then o[:output] = argv[i += 1]
    when "-t", "--threads" then o[:threads] = Integer(argv[i += 1])
    when "--profile" then o[:profile] = true
    else raise "unknown argument: #{argv[i]}"
    end
    i += 1
  end
  raise "optimized Ruby analyzer requires -i and positive -t" if o[:input].nil? || o[:threads] < 1
  o
end

def split_ranges(path, threads)
  size = File.size(path)
  header = "unix_timestamp,channel_path,message_length,stamp_count\n"
  File.open(path, "rb") { |f| raise "unsupported CSV header" unless f.read(header.bytesize) == header }
  starts = [header.bytesize]
  File.open(path, "rb") do |f|
    1.upto(threads - 1) do |i|
      f.seek(header.bytesize + (size - header.bytesize) * i / threads)
      f.gets
      starts << f.pos
    end
  end
  starts.each_with_index.map { |s, i| [s, starts[i + 1] || size] }
end

def analyze_range(path, range)
  stats = {}
  File.open(path, "rb") do |f|
    f.seek(range[0])
    remaining = range[1] - range[0]
    while remaining.positive? && (line = f.gets)
      remaining -= line.bytesize
      next if line.empty?
      ts = line.to_i
      month = MONTH_BY_DAY[(ts - YEAR_START) / 86_400]
      comma1 = line.index(",", 11)
      comma2 = line.index(",", comma1 + 1)
      channel = -line.byteslice(11, comma1 - 11)
      ml = line.byteslice(comma1 + 1, comma2 - comma1 - 1).to_i
      stamps = line.byteslice(comma2 + 1, line.bytesize - comma2 - 1).to_i
      agg = stats[channel]
      unless agg
        agg = Array.new(60, 0)
        stats[channel] = agg
      end
      p = month * 5
      if agg[p + 3].zero?
        agg[p] = agg[p + 1] = agg[p + 2] = ml
        agg[p + 3] = 1
        agg[p + 4] = stamps
      else
        agg[p] = ml if ml < agg[p]
        agg[p + 2] = ml if ml > agg[p + 2]
        agg[p + 1] += ml
        agg[p + 3] += 1
        agg[p + 4] += stamps
      end
    end
  end
  stats
end

def merge!(all, incoming)
  incoming.each do |channel, src|
    dst = all[channel]
    unless dst
      all[channel] = src
      next
    end
    12.times do |m|
      p = m * 5
      next if src[p + 3].zero?
      if dst[p + 3].zero?
        5.times { |j| dst[p + j] = src[p + j] }
      else
        dst[p] = src[p] if src[p] < dst[p]
        dst[p + 2] = src[p + 2] if src[p + 2] > dst[p + 2]
        dst[p + 1] += src[p + 1]
        dst[p + 3] += src[p + 3]
        dst[p + 4] += src[p + 4]
      end
    end
  end
end

def fixed2(total, count)
  value = total.to_f / count
  bits = [value].pack("G").unpack1("Q>")
  exponent_bits = (bits >> 52) & 0x7ff
  fraction = bits & ((1 << 52) - 1)
  mantissa, exponent = exponent_bits.zero? ? [fraction, -1074] : [(1 << 52) | fraction, exponent_bits - 1075]
  scaled = mantissa * 100
  if exponent >= 0
    cents = scaled << exponent
  else
    denominator = 1 << -exponent
    cents, remainder = scaled.divmod(denominator)
    twice = remainder * 2
    cents += 1 if twice > denominator || (twice == denominator && cents.odd?)
  end
  "%d.%02d" % [cents / 100, cents % 100]
end

def write_result(out, stats)
  stats.keys.sort.each do |channel|
    a = stats[channel]
    12.times do |m|
      p = m * 5
      next if a[p + 3].zero?
      out << channel << "," << MONTH_LABEL[m] << "=" << a[p].to_s << "/" << fixed2(a[p + 1], a[p + 3]) << "/" << a[p + 2].to_s << "/" << a[p + 3].to_s << "/" << a[p + 4].to_s << "\n"
    end
  end
end

require "etc"
total_start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
o = options(ARGV)
ranges = split_ranges(o[:input], o[:threads])
worker_start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
pipes = ranges.map do |range|
  read, write = IO.pipe
  pid = fork do
    read.close
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    result = analyze_range(o[:input], range)
    Marshal.dump([Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, result], write)
    write.close
    exit! 0
  end
  write.close
  [pid, read]
end
payloads = Array.new(pipes.length)
readers = pipes.each_with_index.map { |(_, pipe), i| Thread.new { payloads[i] = Marshal.load(pipe); pipe.close } }
readers.each(&:join)
pipes.each { |pid, _| Process.wait(pid) }
worker_wall = Process.clock_gettime(Process::CLOCK_MONOTONIC) - worker_start
merge_start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
merged = {}
payloads.each { |(_, map)| merge!(merged, map) }
merge_time = Process.clock_gettime(Process::CLOCK_MONOTONIC) - merge_start
output_start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
out = o[:output] ? File.open(o[:output], "wb") : STDOUT
write_result(out, merged)
out.close if o[:output]
output_time = Process.clock_gettime(Process::CLOCK_MONOTONIC) - output_start
if o[:profile]
  groups = merged.sum { |_, a| 12.times.count { |m| a[m * 5 + 3] != 0 } }
  warn format("profile workers_wall=%.6f workers_sum=%.6f merge=%.6f output=%.6f total=%.6f chunks=%d groups=%d", worker_wall, payloads.sum(&:first), merge_time, output_time, Process.clock_gettime(Process::CLOCK_MONOTONIC) - total_start, ranges.length, groups)
end
