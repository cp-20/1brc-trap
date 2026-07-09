#!/usr/bin/env ruby
# frozen_string_literal: true

Stats = Struct.new(:min_len, :max_len, :total_len, :messages, :stamps)

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
      raise "invalid header: expected 6 columns, got #{header.length}" unless header.length == 6

      next
    end
    next if line.empty?

    record = line.split(",", -1)
    raise "invalid line #{line_number}: expected 6 columns, got #{record.length}" unless record.length == 6

    channel_id = record[3]
    message_length = Integer(record[4])
    stamp_count = Integer(record[5])

    current = stats[channel_id]
    if current.nil?
      stats[channel_id] = Stats.new(message_length, message_length, message_length, 1, stamp_count)
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
  stats.keys.sort.each do |channel_id|
    s = stats[channel_id]
    mean_len = s.total_len.to_f / s.messages
    output.printf("%s=%d/%s/%d/%d/%d\n", channel_id, s.min_len, format_fixed2(mean_len), s.max_len, s.messages, s.stamps)
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
