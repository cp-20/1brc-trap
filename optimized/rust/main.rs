use std::arch::x86_64::{
    __m256i, _mm256_cmpeq_epi8, _mm256_loadu_si256, _mm256_movemask_epi8,
    _mm256_set1_epi8, _mm_crc32_u64,
};
use std::env;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::os::fd::AsRawFd;
use std::ptr;
use std::slice;
use std::time::Instant;

const CAP: usize = 1 << 15;
const YEAR_START: u32 = 1_798_761_600;
const MONTH_START: [u32; 13] = [
    1_798_761_600,
    1_801_440_000,
    1_803_859_200,
    1_806_537_600,
    1_809_129_600,
    1_811_808_000,
    1_814_400_000,
    1_817_078_400,
    1_819_756_800,
    1_822_348_800,
    1_825_027_200,
    1_827_619_200,
    1_830_297_600,
];
const MONTH_LABEL: [&[u8]; 12] = [
    b"2027-01", b"2027-02", b"2027-03", b"2027-04", b"2027-05", b"2027-06", b"2027-07", b"2027-08",
    b"2027-09", b"2027-10", b"2027-11", b"2027-12",
];

unsafe extern "C" {
    fn mmap(addr: *mut c_void, len: usize, prot: i32, flags: i32, fd: i32, off: i64)
        -> *mut c_void;
    fn munmap(addr: *mut c_void, len: usize) -> i32;
    fn madvise(addr: *mut c_void, len: usize, advice: i32) -> i32;
}
struct Mapping {
    ptr: *mut u8,
    len: usize,
    _file: File,
}
impl Mapping {
    fn open(path: &str) -> Result<Self, String> {
        let f = File::open(path).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len() as usize;
        if len == 0 {
            return Err("input is empty".into());
        }
        unsafe {
            let p = mmap(ptr::null_mut(), len, 1, 2, f.as_raw_fd(), 0);
            if p as isize == -1 {
                return Err(io::Error::last_os_error().to_string());
            }
            let _ = madvise(p, len, 2);
            Ok(Self {
                ptr: p.cast(),
                len,
                _file: f,
            })
        }
    }
    fn bytes(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.ptr, self.len) }
    }
}
impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            munmap(self.ptr.cast(), self.len);
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Stats {
    total_len: u64,
    stamps: u64,
    messages: u32,
    min_len: u16,
    max_len: u16,
}
#[derive(Clone)]
struct Agg {
    month: [Stats; 12],
}
impl Default for Agg {
    fn default() -> Self {
        Self {
            month: [Stats::default(); 12],
        }
    }
}
#[derive(Clone, Copy, Default)]
struct Entry {
    pos: usize,
    len: u32,
    id: u16,
    tag: u16,
}
struct FlatMap {
    entries: Vec<Entry>,
    aggs: Vec<Agg>,
    size: usize,
}
impl FlatMap {
    fn new() -> Self {
        Self {
            entries: vec![Entry::default(); CAP],
            aggs: Vec::with_capacity(CAP / 2),
            size: 0,
        }
    }
    #[inline(always)]
    fn find(&mut self, data: &[u8], pos: usize, len: u32, hash: u32) -> usize {
        let mut i = hash as usize & (CAP - 1);
        let tag = (hash >> 16) as u16;
        loop {
            let e = self.entries[i];
            if e.len == 0 {
                let id = self.aggs.len() as u16;
                self.entries[i] = Entry { pos, len, id, tag };
                self.aggs.push(Agg::default());
                self.size += 1;
                return i;
            }
            if e.tag == tag
                && e.len == len
                && data[e.pos..e.pos + len as usize] == data[pos..pos + len as usize]
            {
                return i;
            }
            i = (i + 1) & (CAP - 1)
        }
    }
    fn add(
        &mut self,
        data: &[u8],
        pos: usize,
        len: u32,
        hash: u32,
        month: usize,
        ml: u32,
        stamps: u32,
    ) {
        let i = self.find(data, pos, len, hash);
        let s = &mut self.aggs[self.entries[i].id as usize].month[month];
        if s.messages == 0 {
            *s = Stats {
                total_len: ml as u64,
                stamps: stamps as u64,
                messages: 1,
                min_len: ml as u16,
                max_len: ml as u16,
            }
        } else {
            s.messages += 1;
            s.total_len += ml as u64;
            s.stamps += stamps as u64;
            s.min_len = s.min_len.min(ml as u16);
            s.max_len = s.max_len.max(ml as u16)
        }
    }
    fn merge(&mut self, data: &[u8], other: &FlatMap) {
        for e in other.entries.iter().filter(|e| e.len != 0) {
            let i = self.find(data, e.pos, e.len, hash_bytes(&data[e.pos..e.pos + e.len as usize]));
            let dst = &mut self.aggs[self.entries[i].id as usize];
            let src = &other.aggs[e.id as usize];
            for m in 0..12 {
                let a = src.month[m];
                let b = &mut dst.month[m];
                if a.messages == 0 {
                    continue;
                }
                if b.messages == 0 {
                    *b = a
                } else {
                    b.messages += a.messages;
                    b.total_len += a.total_len;
                    b.stamps += a.stamps;
                    b.min_len = b.min_len.min(a.min_len);
                    b.max_len = b.max_len.max(a.max_len)
                }
            }
        }
    }
    fn groups(&self) -> usize {
        self.aggs
            .iter()
            .map(|a| a.month.iter().filter(|s| s.messages != 0).count())
            .sum()
    }
}
#[inline]
fn load64(p: &[u8]) -> u64 {
    unsafe { ptr::read_unaligned(p.as_ptr().cast()) }
}
#[inline]
fn hash_bytes(p: &[u8]) -> u32 {
    let n = p.len();
    let mut hash = n as u64;
    let mut i = 0;
    while i + 8 <= n {
        hash = unsafe { _mm_crc32_u64(hash, load64(&p[i..])) };
        i += 8;
    }
    if n < 8 {
        let mut x = 0;
        for (i, &byte) in p.iter().enumerate() {
            x |= (byte as u64) << (8 * i)
        }
        hash = unsafe { _mm_crc32_u64(hash, x) };
    } else if i < n {
        hash = unsafe { _mm_crc32_u64(hash, load64(&p[n - 8..])) };
    }
    hash as u32
}
#[inline]
fn timestamp(p: &[u8]) -> u32 {
    let mut x = load64(p) & 0x0f0f0f0f0f0f0f0f;
    x = (x & 0x000f000f000f000f) * 10 + ((x >> 8) & 0x000f000f000f000f);
    x = (x & 0x000000ff000000ff) * 100 + ((x >> 16) & 0x000000ff000000ff);
    let first8 = (x as u32) * 10000 + (x >> 32) as u32;
    first8 * 100 + (p[8] - b'0') as u32 * 10 + (p[9] - b'0') as u32
}
#[inline]
fn channel_length(data: &[u8], begin: usize, end: usize) -> usize {
    let comma = unsafe { _mm256_set1_epi8(b',' as i8) };
    let mut offset = 0;
    while begin + offset + 32 <= end {
        let block = unsafe {
            _mm256_loadu_si256(data.as_ptr().add(begin + offset).cast::<__m256i>())
        };
        let mask = unsafe { _mm256_movemask_epi8(_mm256_cmpeq_epi8(block, comma)) } as u32;
        if mask != 0 {
            return offset + mask.trailing_zeros() as usize;
        }
        offset += 32;
    }
    while begin + offset < end && data[begin + offset] != b',' {
        offset += 1;
    }
    offset
}
fn month_table() -> [u8; 365] {
    let mut a = [0; 365];
    let mut m = 0;
    for (d, x) in a.iter_mut().enumerate() {
        let ts = YEAR_START + d as u32 * 86400;
        if ts >= MONTH_START[m + 1] {
            m += 1
        }
        *x = m as u8
    }
    a
}
fn analyze_chunk(data: &[u8], begin: usize, end: usize, months: &[u8; 365]) -> FlatMap {
    let mut map = FlatMap::new();
    let mut p = begin;
    while p < end {
        if data[p] == b'\n' || data[p] == b'\r' {
            p += 1;
            continue;
        }
        let ts = timestamp(&data[p..p + 10]);
        let month = months[((ts - YEAR_START) / 86400) as usize] as usize;
        p += 11;
        let key = p;
        p += channel_length(data, key, end);
        let len = (p - key) as u32;
        let hash = hash_bytes(&data[key..p]);
        p += 1;
        let mut ml = (data[p] - b'0') as u32;
        p += 1;
        while data[p] != b',' {
            ml = ml * 10 + (data[p] - b'0') as u32;
            p += 1
        }
        p += 1;
        let mut stamps = (data[p] - b'0') as u32;
        p += 1;
        while data[p] != b'\n' {
            stamps = stamps * 10 + (data[p] - b'0') as u32;
            p += 1
        }
        p += 1;
        map.add(data, key, len, hash, month, ml, stamps)
    }
    map
}

struct Options {
    input: String,
    output: String,
    threads: usize,
    profile: bool,
}
fn options() -> Result<Options, String> {
    let a: Vec<String> = env::args().skip(1).collect();
    let mut o = Options {
        input: String::new(),
        output: String::new(),
        threads: std::thread::available_parallelism()
            .map(|x| x.get())
            .unwrap_or(1),
        profile: false,
    };
    if a.len() == 2 && !a[0].starts_with('-') && !a[1].starts_with('-') {
        o.input = a[0].clone();
        o.output = a[1].clone();
        return Ok(o);
    }
    let mut i = 0;
    while i < a.len() {
        match a[i].as_str() {
            "-i" | "--input" => {
                i += 1;
                o.input = a.get(i).ok_or("missing input")?.clone()
            }
            "-o" | "--output" => {
                i += 1;
                o.output = a.get(i).ok_or("missing output")?.clone()
            }
            "-t" | "--threads" => {
                i += 1;
                o.threads = a
                    .get(i)
                    .ok_or("missing threads")?
                    .parse()
                    .map_err(|_| "invalid threads")?
            }
            "--profile" => o.profile = true,
            x => return Err(format!("unknown argument: {x}")),
        }
        i += 1
    }
    if o.input.is_empty() || o.threads == 0 {
        return Err("optimized Rust analyzer requires -i and positive -t".into());
    }
    Ok(o)
}
fn write_result(out: &mut dyn Write, data: &[u8], map: &FlatMap) -> io::Result<()> {
    let mut entries: Vec<Entry> = map.entries.iter().copied().filter(|e| e.len != 0).collect();
    entries.sort_unstable_by(|a, b| {
        data[a.pos..a.pos + a.len as usize].cmp(&data[b.pos..b.pos + b.len as usize])
    });
    let mut w = BufWriter::with_capacity(4 << 20, out);
    for e in entries {
        for (m, s) in map.aggs[e.id as usize].month.iter().enumerate() {
            if s.messages == 0 {
                continue;
            }
            w.write_all(&data[e.pos..e.pos + e.len as usize])?;
            w.write_all(b",")?;
            w.write_all(MONTH_LABEL[m])?;
            writeln!(
                w,
                "={}/{:.2}/{}/{}/{}",
                s.min_len,
                s.total_len as f64 / s.messages as f64,
                s.max_len,
                s.messages,
                s.stamps
            )?
        }
    }
    w.flush()
}
fn run() -> Result<(), String> {
    let o = options()?;
    let total = Instant::now();
    let t = Instant::now();
    let mapping = Mapping::open(&o.input)?;
    let mmap_time = t.elapsed();
    let data = mapping.bytes();
    let header = b"unix_timestamp,channel_path,message_length,stamp_count\n";
    if !data.starts_with(header) {
        return Err("unsupported CSV header".into());
    }
    let begin = header.len();
    let mut chunks = Vec::new();
    let mut start = begin;
    for i in 1..o.threads {
        let target = begin + (data.len() - begin) * i / o.threads;
        let nl = data[target..]
            .iter()
            .position(|&x| x == b'\n')
            .map(|x| target + x + 1)
            .unwrap_or(data.len());
        chunks.push((start, nl));
        start = nl
    }
    chunks.push((start, data.len()));
    let months = month_table();
    let t = Instant::now();
    let results: Vec<(FlatMap, f64)> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .iter()
            .map(|&(a, b)| {
                scope.spawn(move || {
                    let t = Instant::now();
                    let m = analyze_chunk(data, a, b, &months);
                    (m, t.elapsed().as_secs_f64())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let worker_wall = t.elapsed();
    let worker_sum: f64 = results.iter().map(|x| x.1).sum();
    let t = Instant::now();
    let mut merged = FlatMap::new();
    for (m, _) in &results {
        merged.merge(data, m)
    }
    let merge = t.elapsed();
    let mut file;
    let mut stdout;
    let out: &mut dyn Write = if o.output.is_empty() {
        stdout = io::stdout();
        &mut stdout
    } else {
        file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&o.output)
            .map_err(|e| e.to_string())?;
        &mut file
    };
    let t = Instant::now();
    write_result(out, data, &merged).map_err(|e| e.to_string())?;
    let output = t.elapsed();
    if o.profile {
        eprintln!("profile mmap={:.6} workers_wall={:.6} workers_sum={:.6} merge={:.6} output={:.6} total={:.6} chunks={} groups={}",mmap_time.as_secs_f64(),worker_wall.as_secs_f64(),worker_sum,merge.as_secs_f64(),output.as_secs_f64(),total.elapsed().as_secs_f64(),chunks.len(),merged.groups())
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1)
    }
}
