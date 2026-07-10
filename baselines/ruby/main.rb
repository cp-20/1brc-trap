#!/usr/bin/env ruby
# frozen_string_literal: true

Stats = Struct.new(:min_len, :max_len, :total_len, :messages, :stamps)

MONTH_START_UNIX = [
  1_798_761_600, 1_801_440_000, 1_803_859_200, 1_806_537_600, 1_809_129_600,
  1_811_808_000, 1_814_400_000, 1_817_078_400, 1_819_756_800, 1_822_348_800,
  1_825_027_200, 1_827_619_200, 1_830_297_600
].freeze

MONTH_LABELS = [
  "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
  "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"
].freeze

def result_key(unix_timestamp, channel_path)
  "#{channel_path},#{month_label_from_unix_timestamp(Integer(unix_timestamp))}"
end

def month_label_from_unix_timestamp(timestamp)
  (MONTH_LABELS.length - 1).downto(0) do |i|
    return MONTH_LABELS[i] if timestamp >= MONTH_START_UNIX[i] && timestamp < MONTH_START_UNIX[i + 1]
  end
  raise "unix_timestamp out of 2027 range: #{timestamp}"
end

def parse_args(args)
  options = { input: nil, output: nil }
  i = 0
  while i < args.length
    case args[i]
    when "-i"
      i += 1
      raise "missing value for -i" if i >= args.length

      options[:input] = args[i]
    when "-o"
      i += 1
      raise "missing value for -o" if i >= args.length

      options[:output] = args[i]
    else
      raise "unknown argument: #{args[i]}"
    end
    i += 1
  end
  options
end

def analyze(input)
  stats = {}
  line_number = 0
  input.each_line do |line|
    line_number += 1
    line = line.chomp
    if line_number == 1
      header = line.split(",", -1)
      raise "invalid header: expected 4 columns, got #{header.length}" unless header.length == 4

      next
    end
    next if line.empty?

    record = line.split(",", -1)
    raise "invalid line #{line_number}: expected 4 columns, got #{record.length}" unless record.length == 4

    key = result_key(record[0], record[1])
    message_length = Integer(record[2])
    stamp_count = Integer(record[3])

    current = stats[key]
    if current.nil?
      stats[key] = Stats.new(message_length, message_length, message_length, 1, stamp_count)
    else
      current.min_len = message_length if message_length < current.min_len
      current.max_len = message_length if message_length > current.max_len
      current.total_len += message_length
      current.messages += 1
      current.stamps += stamp_count
    end
  end
  stats
end

def write_result(output, stats)
  stats.keys.sort.each do |key|
    s = stats[key]
    mean_len = s.total_len.to_f / s.messages
    output.printf("%s=%d/%s/%d/%d/%d\n", key, s.min_len, format_fixed2(mean_len), s.max_len, s.messages, s.stamps)
  end
end

def format_fixed2(value)
  bits = [value].pack("G").unpack1("Q>")
  exponent_bits = (bits >> 52) & 0x7ff
  fraction = bits & ((1 << 52) - 1)
  if exponent_bits.zero?
    mantissa = fraction
    exponent = -1022 - 52
  else
    mantissa = (1 << 52) | fraction
    exponent = exponent_bits - 1023 - 52
  end

  scaled = mantissa * 100
  cents =
    if exponent >= 0
      scaled << exponent
    else
      denominator = 1 << -exponent
      rounded = scaled / denominator
      remainder = scaled % denominator
      twice = remainder * 2
      rounded += 1 if twice > denominator || (twice == denominator && rounded.odd?)
      rounded
    end

  format("%d.%02d", cents / 100, cents % 100)
end

begin
  options = parse_args(ARGV)
  input = options[:input].nil? ? STDIN : File.open(options[:input], "r")
  output = options[:output].nil? ? STDOUT : File.open(options[:output], "w")
  stats = analyze(input)
  write_result(output, stats)
ensure
  input&.close unless input.nil? || input == STDIN
  output&.close unless output.nil? || output == STDOUT
end
