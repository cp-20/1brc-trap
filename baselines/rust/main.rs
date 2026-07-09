use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};

struct ChannelStats {
    min_len: i64,
    max_len: i64,
    total_len: i64,
    messages: i64,
    stamps: i64,
}

struct Options {
    input: String,
    output: String,
}

fn parse_args() -> Result<Options, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut options = Options {
        input: String::new(),
        output: String::new(),
    };
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-i" && i + 1 < args.len() {
            i += 1;
            options.input = args[i].clone();
        } else if args[i] == "-o" && i + 1 < args.len() {
            i += 1;
            options.output = args[i].clone();
        } else {
            return Err(format!("unknown or incomplete argument: {}", args[i]));
        }
        i += 1;
    }
    Ok(options)
}

fn analyze(reader: Box<dyn BufRead>) -> Result<HashMap<String, ChannelStats>, String> {
    let mut stats: HashMap<String, ChannelStats> = HashMap::new();

    for (line_index, line_result) in reader.lines().enumerate() {
        let line_number = line_index + 1;
        let line = line_result.map_err(|e| format!("failed to read line {}: {}", line_number, e))?;
        if line_number == 1 {
            let header: Vec<&str> = line.split(',').collect();
            if header.len() != 6 {
                return Err(format!("invalid header: expected 6 columns, got {}", header.len()));
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }

        let record: Vec<&str> = line.split(',').collect();
        if record.len() != 6 {
            return Err(format!("invalid line {}: expected 6 columns, got {}", line_number, record.len()));
        }

        let channel_id = record[3];
        let message_length: i64 = record[4]
            .parse()
            .map_err(|e| format!("invalid message_length on line {}: {}", line_number, e))?;
        let stamp_count: i64 = record[5]
            .parse()
            .map_err(|e| format!("invalid stamp_count on line {}: {}", line_number, e))?;

        match stats.get_mut(channel_id) {
            Some(current) => {
                if message_length < current.min_len {
                    current.min_len = message_length;
                }
                if message_length > current.max_len {
                    current.max_len = message_length;
                }
                current.total_len += message_length;
                current.messages += 1;
                current.stamps += stamp_count;
            }
            None => {
                stats.insert(
                    channel_id.to_string(),
                    ChannelStats {
                        min_len: message_length,
                        max_len: message_length,
                        total_len: message_length,
                        messages: 1,
                        stamps: stamp_count,
                    },
                );
            }
        }
    }

    Ok(stats)
}

fn write_result(writer: &mut dyn Write, stats: &HashMap<String, ChannelStats>) -> io::Result<()> {
    let mut channel_ids: Vec<&String> = stats.keys().collect();
    channel_ids.sort();

    for channel_id in channel_ids {
        let s = stats.get(channel_id).unwrap();
        let mean_len = s.total_len as f64 / s.messages as f64;
        writeln!(
            writer,
            "{}={}/{:.2}/{}/{}/{}",
            channel_id, s.min_len, mean_len, s.max_len, s.messages, s.stamps
        )?;
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let options = parse_args()?;
    let reader: Box<dyn BufRead> = if options.input.is_empty() {
        Box::new(BufReader::new(io::stdin()))
    } else {
        Box::new(BufReader::new(File::open(&options.input).map_err(|e| format!("failed to open input: {}", e))?))
    };

    let stats = analyze(reader)?;
    if options.output.is_empty() {
        let mut stdout = io::stdout();
        write_result(&mut stdout, &stats).map_err(|e| format!("failed to write output: {}", e))?;
    } else {
        let mut file = File::create(&options.output).map_err(|e| format!("failed to create output: {}", e))?;
        write_result(&mut file, &stats).map_err(|e| format!("failed to write output: {}", e))?;
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{}", e);
        std::process::exit(1);
    }
}
