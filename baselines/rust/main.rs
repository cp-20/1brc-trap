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

const MONTH_START_UNIX: [i64; 13] = [
    1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000, 1814400000,
    1817078400, 1819756800, 1822348800, 1825027200, 1827619200, 1830297600,
];

const MONTH_LABELS: [&str; 12] = [
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07",
    "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
];

fn result_key(unix_timestamp: &str, channel_path: &str) -> Result<String, String> {
    let timestamp: i64 = unix_timestamp
        .parse()
        .map_err(|e| format!("invalid unix_timestamp: {}", e))?;
    let month = month_label_from_unix_timestamp(timestamp)?;
    Ok(format!("{},{}", channel_path, month))
}

fn month_label_from_unix_timestamp(timestamp: i64) -> Result<&'static str, String> {
    for i in (0..MONTH_LABELS.len()).rev() {
        if timestamp >= MONTH_START_UNIX[i] && timestamp < MONTH_START_UNIX[i + 1] {
            return Ok(MONTH_LABELS[i]);
        }
    }
    Err(format!("unix_timestamp out of 2027 range: {}", timestamp))
}

fn parse_args() -> Result<Options, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() == 2 && !args[0].starts_with('-') && !args[1].starts_with('-') {
        return Ok(Options {
            input: args[0].clone(),
            output: args[1].clone(),
        });
    }
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
            if header.len() != 4 {
                return Err(format!("invalid header: expected 4 columns, got {}", header.len()));
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }

        let record: Vec<&str> = line.split(',').collect();
        if record.len() != 4 {
            return Err(format!("invalid line {}: expected 4 columns, got {}", line_number, record.len()));
        }

        let key = result_key(record[0], record[1]).map_err(|e| format!("invalid key on line {}: {}", line_number, e))?;
        let message_length: i64 = record[2]
            .parse()
            .map_err(|e| format!("invalid message_length on line {}: {}", line_number, e))?;
        let stamp_count: i64 = record[3]
            .parse()
            .map_err(|e| format!("invalid stamp_count on line {}: {}", line_number, e))?;

        match stats.get_mut(&key) {
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
                    key,
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
    let mut keys: Vec<&String> = stats.keys().collect();
    keys.sort();

    for key in keys {
        let s = stats.get(key).unwrap();
        let mean_len = s.total_len as f64 / s.messages as f64;
        writeln!(
            writer,
            "{}={}/{:.2}/{}/{}/{}",
            key, s.min_len, mean_len, s.max_len, s.messages, s.stamps
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
