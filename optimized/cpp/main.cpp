#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <immintrin.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

// Rejected: enabling BMI/BMI2 emitted BZHI/SHLX but slowed the official build.
#pragma GCC target("avx2,sse4.2")

using Clock = std::chrono::steady_clock;
static constexpr size_t MAP_CAPACITY = 1u << 14;
static constexpr uint32_t YEAR_START = 1798761600u;
static constexpr uint32_t MONTH_START[] = {
    1798761600u, 1801440000u, 1803859200u, 1806537600u, 1809129600u,
    1811808000u, 1814400000u, 1817078400u, 1819756800u, 1822348800u,
    1825027200u, 1827619200u, 1830297600u};
static constexpr const char *MONTH_LABEL[] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"};

struct alignas(16) Stats {
  // Contest inputs keep every channel-month accumulator below UINT32_MAX.
  uint32_t total_len, stamps, messages;
  // The sentinel makes the overwhelmingly hot update path branch-free.
  uint16_t min_len, max_len;
};
struct ChannelAgg {
  Stats month[12];
  ChannelAgg() {
    // Rejected: six unaligned 256-bit stores lost to twelve aligned stores.
    const __m128i empty = _mm_set_epi32(0x0000ffff, 0, 0, 0);
    for (Stats &s : month)
      _mm_store_si128(reinterpret_cast<__m128i *>(&s), empty);
  }
};
struct MapEntry {
  uintptr_t key = 0;
  uint32_t hash = 0;
  uint16_t len = 0, id = 0;
};
struct Chunk {
  const char *begin, *end;
};
struct Profile {
  double mmap = 0, split = 0, worker_wall = 0, worker_sum = 0, merge = 0,
         output = 0;
  size_t chunks = 0, groups = 0;
};

static double seconds(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double>(b - a).count();
}
static inline uint64_t load64(const char *p) {
  uint64_t x;
  std::memcpy(&x, p, sizeof(x));
  return x;
}
static inline uint32_t load32(const char *p) {
  uint32_t x;
  std::memcpy(&x, p, sizeof(x));
  return x;
}
static inline uint16_t load16(const char *p) {
  uint16_t x;
  std::memcpy(&x, p, sizeof(x));
  return x;
}
static inline bool key_equal(const char *a, const char *b, uint32_t n) {
  // Rejected: two 16-byte SIMD comparisons for long keys used more vector
  // uops/registers and lost to the predicted scalar comparisons below.
  if (n >= 8) {
    if (load64(a) != load64(b))
      return false;
    if (n == 8)
      return true;
    if (n <= 16)
      return load64(a + n - 8) == load64(b + n - 8);
    if (load64(a + 8) != load64(b + 8))
      return false;
    if (n <= 24)
      return load64(a + n - 8) == load64(b + n - 8);
    if (n <= 32)
      return load64(a + 16) == load64(b + 16) &&
             load64(a + n - 8) == load64(b + n - 8);
    return std::memcmp(a + 16, b + 16, n - 16) == 0;
  }
  if (n >= 4) {
    if (load32(a) != load32(b))
      return false;
    return n == 4 || load32(a + n - 4) == load32(b + n - 4);
  }
  if (n >= 2) {
    if (load16(a) != load16(b))
      return false;
    return n == 2 || load16(a + n - 2) == load16(b + n - 2);
  }
  return !n || *a == *b;
}
static inline const char *entry_key(const MapEntry &e) {
  return e.len <= 8 ? reinterpret_cast<const char *>(&e.key)
                    : reinterpret_cast<const char *>(e.key);
}
static inline uint64_t rotl64(uint64_t x, unsigned n) {
  return (x << (n & 63)) | (x >> ((64 - n) & 63));
}
static inline uint32_t hash_bytes(const char *p, size_t n,
                                  const char *end, uint64_t *short_key) {
  uint64_t hash = n;
  if (n <= 8) {
    uint64_t x;
    if (n == 8) {
      x = load64(p);
    } else if (p + 8 <= end) {
      x = load64(p) & ((UINT64_C(1) << (n * 8)) - 1);
    } else if (n >= 4) {
      x = load32(p);
      x |= uint64_t(load32(p + n - 4)) << ((n - 4) * 8);
    } else if (n >= 2) {
      x = load16(p);
      x |= uint64_t(load16(p + n - 2)) << ((n - 2) * 8);
    } else {
      x = n ? uint8_t(*p) : 0;
    }
    *short_key = x;
    return uint32_t(_mm_crc32_u64(hash, x));
  }
  uint64_t x = load64(p);
  if (n > 8)
    x ^= rotl64(load64(p + n - 8), unsigned(n));
  // Rejected: hashing only first+last increased probing on channel paths.
  if (n > 16)
    x ^= rotl64(load64(p + n / 2 - 4), unsigned(n) / 2);
  return uint32_t(_mm_crc32_u64(hash, x));
}

class FlatMap {
public:
  FlatMap() : entries_(MAP_CAPACITY), aggs_() {
    aggs_.reserve(MAP_CAPACITY);
  }
  void add(const char *key, uint32_t len, uint32_t hash, uint64_t short_key,
           uint32_t month, uint32_t message_len, uint32_t stamps) {
    MapEntry *e = find_or_insert(key, len, hash, short_key);
    Stats &s = aggs_[e->id].month[month];
    __m128i values = _mm_load_si128(reinterpret_cast<const __m128i *>(&s));
    __m128i increment = _mm_set_epi32(0, 1, stamps, message_len);
    _mm_store_si128(reinterpret_cast<__m128i *>(&s),
                    _mm_add_epi32(values, increment));
    if (message_len < s.min_len)
      s.min_len = message_len;
    if (message_len > s.max_len)
      s.max_len = message_len;
  }
  void merge_from(const FlatMap &other) {
    for (const MapEntry &src : other.entries_) {
      if (!src.len)
        continue;
      const char *key = entry_key(src);
      MapEntry *dst = find_or_insert(key, src.len, src.hash, src.key);
      for (unsigned m = 0; m < 12; ++m) {
        const Stats &a = other.aggs_[src.id].month[m];
        if (!a.messages)
          continue;
        Stats &b = aggs_[dst->id].month[m];
        if (!b.messages)
          b = a;
        else {
          b.messages += a.messages;
          b.total_len += a.total_len;
          b.stamps += a.stamps;
          if (a.min_len < b.min_len)
            b.min_len = a.min_len;
          if (a.max_len > b.max_len)
            b.max_len = a.max_len;
        }
      }
    }
  }
  const std::vector<MapEntry> &entries() const { return entries_; }
  const ChannelAgg &agg(uint32_t id) const { return aggs_[id]; }
  size_t size() const { return size_; }
  size_t groups() const {
    size_t n = 0;
    for (const auto &a : aggs_)
      for (const auto &s : a.month)
        n += s.messages != 0;
    return n;
  }

private:
  MapEntry *find_or_insert(const char *key, uint32_t len, uint32_t hash,
                           uint64_t short_key) {
    size_t mask = entries_.size() - 1, i = hash & mask;
    for (;;) {
      MapEntry &e = entries_[i];
      // Rejected: outlining this rare insertion path shrank code but slowed
      // 8-thread runs; keeping it here lets the compiler share live state.
      if (!e.len) {
        e = MapEntry{len <= 8 ? uintptr_t(short_key)
                              : reinterpret_cast<uintptr_t>(key),
                     hash, uint16_t(len), uint16_t(aggs_.size())};
        aggs_.emplace_back();
        ++size_;
        return &e;
      }
      // Rejected: treating 32-bit hash+length as identity already collides in
      // public-1M, so retain exact key verification on every matching hash.
      if (e.hash == hash && e.len == len &&
          (len <= 8 ? e.key == short_key
                    : key_equal(reinterpret_cast<const char *>(e.key), key,
                                len)))
        return &e;
      i = (i + 1) & mask;
    }
  }
  std::vector<MapEntry> entries_;
  std::vector<ChannelAgg> aggs_;
  size_t size_ = 0;
};

struct MappedFile {
  int fd = -1;
  const char *data = nullptr;
  size_t size = 0;
  explicit MappedFile(const char *path) {
    fd = open(path, O_RDONLY);
    if (fd < 0)
      throw std::runtime_error("failed to open input");
    struct stat st {};
    if (fstat(fd, &st) || st.st_size <= 0)
      throw std::runtime_error("failed to stat input");
    size = size_t(st.st_size);
    void *p = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (p == MAP_FAILED)
      throw std::runtime_error("failed to mmap input");
    data = static_cast<const char *>(p);
    madvise(const_cast<char *>(data), size, MADV_SEQUENTIAL);
  }
  ~MappedFile() {
    if (data)
      munmap(const_cast<char *>(data), size);
    if (fd >= 0)
      close(fd);
  }
  MappedFile(const MappedFile &) = delete;
};

static uint8_t month_by_day[365];
static void init_months() {
  unsigned m = 0;
  for (unsigned d = 0; d < 365; ++d) {
    uint32_t ts = YEAR_START + d * 86400u;
    if (ts >= MONTH_START[m + 1])
      ++m;
    month_by_day[d] = uint8_t(m);
  }
}
static inline uint32_t parse_timestamp8(const char *p) {
  // Rejected: SSSE3 maddubs+maddwd used fewer instructions, but their serial
  // multiply latency made the 8-thread hot loop slower than scalar SWAR.
  uint64_t x = load64(p) & 0x0f0f0f0f0f0f0f0fULL;
  x = (x & 0x000f000f000f000fULL) * 10 +
      ((x >> 8) & 0x000f000f000f000fULL);
  x = (x & 0x000000ff000000ffULL) * 100 +
      ((x >> 16) & 0x000000ff000000ffULL);
  return uint32_t(x) * 10000 + uint32_t(x >> 32);
}
static inline uint32_t channel_length(const char *p, const char *end) {
  const __m128i comma = _mm_set1_epi8(',');
  uint32_t offset = 0;
  // Rejected: carrying the first SIMD block into hashing saved one load but
  // increased register pressure and slowed the complete worker loop.
  // Rejected: an unconditional 16-byte overread loop removed bounds checks
  // but regressed 8-thread runs and was unsafe at an exact page boundary.
  while (p + offset + 16 <= end) {
    uint32_t mask = uint32_t(_mm_movemask_epi8(_mm_cmpeq_epi8(
        _mm_loadu_si128(reinterpret_cast<const __m128i *>(p + offset)),
        comma)));
    if (mask)
      return offset + uint32_t(__builtin_ctz(mask));
    offset += 16;
  }
  while (p + offset < end && p[offset] != ',')
    ++offset;
  return offset;
}
static FlatMap analyze_chunk(Chunk c) {
  FlatMap map;
  const char *p = c.begin;
  while (p < c.end) {
    // Rejected: removing this predicted guard saved two branches but did not
    // produce a repeatable total-runtime win and dropped blank-line handling.
    if (*p == '\n' || *p == '\r') {
      ++p;
      continue;
    }
    uint32_t ts100 = parse_timestamp8(p);
    uint32_t month = month_by_day[(ts100 - YEAR_START / 100u) / 864u];
    p += 11;
    const char *key = p;
    uint32_t len = channel_length(key, c.end);
    p += len;
    uint64_t short_key = 0;
    uint32_t hash = hash_bytes(key, len, c.end, &short_key);
    // Rejected: map-slot prefetch and a two-stage map/Stats prefetch schedule
    // both increased pressure/spills in the complete worker loop.
    ++p;
    uint32_t message_len;
    if (__builtin_expect(p[3] == ',', 1)) {
      message_len = uint8_t(p[0] - '0') * 100u +
                    uint8_t(p[1] - '0') * 10u + uint8_t(p[2] - '0');
      p += 4;
    } else {
      // Rejected: a separate two-digit fast branch enlarged the hot loop and
      // lost to this compact fallback despite avoiding two iterations.
      message_len = uint8_t(*p++ - '0');
      while (*p != ',')
        message_len = message_len * 10 + uint8_t(*p++ - '0');
      ++p;
    }
    uint32_t stamps = uint8_t(*p++ - '0');
    while (*p != '\n')
      stamps = stamps * 10 + uint8_t(*p++ - '0');
    ++p;
    map.add(key, len, hash, short_key, month, message_len, stamps);
  }
  return map;
}
static std::vector<Chunk> split_chunks(const char *begin, const char *end,
                                       unsigned threads) {
  std::vector<Chunk> out;
  size_t bytes = size_t(end - begin);
  threads = std::max(1u, std::min(threads, unsigned(bytes / 4096 + 1)));
  const char *start = begin;
  for (unsigned i = 1; i < threads; ++i) {
    const char *target = begin + bytes * i / threads;
    const char *nl = static_cast<const char *>(
        std::memchr(target, '\n', size_t(end - target)));
    const char *stop = nl ? nl + 1 : end;
    if (start < stop)
      out.push_back({start, stop});
    start = stop;
  }
  if (start < end)
    out.push_back({start, end});
  return out;
}
static FlatMap analyze(const char *data, size_t size, unsigned threads,
                       Profile *prof) {
  const char *end = data + size;
  const char *nl = static_cast<const char *>(std::memchr(data, '\n', size));
  constexpr std::string_view header =
      "unix_timestamp,channel_path,message_length,stamp_count";
  if (!nl || std::string_view(data, size_t(nl - data)) != header)
    throw std::runtime_error("unsupported CSV header");
  auto t = Clock::now();
  auto chunks = split_chunks(nl + 1, end, threads);
  if (prof) {
    prof->split = seconds(t, Clock::now());
    prof->chunks = chunks.size();
  }
  std::vector<FlatMap> locals(chunks.size());
  std::vector<double> elapsed(chunks.size());
  std::vector<std::thread> workers;
  t = Clock::now();
  for (size_t i = 0; i < chunks.size(); ++i)
    workers.emplace_back([&, i] {
      auto s = Clock::now();
      locals[i] = analyze_chunk(chunks[i]);
      elapsed[i] = seconds(s, Clock::now());
    });
  for (auto &w : workers)
    w.join();
  if (prof) {
    prof->worker_wall = seconds(t, Clock::now());
    for (double x : elapsed)
      prof->worker_sum += x;
  }
  t = Clock::now();
  FlatMap merged = std::move(locals.front());
  for (size_t i = 1; i < locals.size(); ++i)
    merged.merge_from(locals[i]);
  if (prof) {
    prof->merge = seconds(t, Clock::now());
    prof->groups = merged.groups();
  }
  return merged;
}
static char *append_uint(char *p, uint64_t x) {
  char reversed[20];
  unsigned n = 0;
  do {
    reversed[n++] = char('0' + x % 10);
    x /= 10;
  } while (x);
  while (n)
    *p++ = reversed[--n];
  return p;
}
static char *append_average(char *p, uint64_t total, uint32_t count) {
  // Rejected: rational integer rounding disagrees with binary64 %.2f at ties.
  double average = double(total) / double(count);
  long double exact = (long double)average * 100.0L;
  uint64_t scaled = uint64_t(exact);
  long double fraction = exact - (long double)scaled;
  if (fraction > 0.5L || (fraction == 0.5L && (scaled & 1)))
    ++scaled;
  p = append_uint(p, scaled / 100);
  *p++ = '.';
  *p++ = char('0' + scaled / 10 % 10);
  *p++ = char('0' + scaled % 10);
  return p;
}
static void write_result(std::ostream &out, const FlatMap &map) {
  // Rejected: emitting hash-table order is valid but did not improve total
  // runtime, so retain deterministic output at negligible 1B-scale cost.
  std::vector<const MapEntry *> entries;
  entries.reserve(map.size());
  for (const auto &e : map.entries())
    if (e.len)
      entries.push_back(&e);
  std::sort(entries.begin(), entries.end(), [](auto a, auto b) {
    int c = std::memcmp(entry_key(*a), entry_key(*b),
                        std::min(a->len, b->len));
    return c < 0 || (c == 0 && a->len < b->len);
  });
  std::string buf;
  buf.reserve(8u << 20);
  char line[96];
  for (auto e : entries)
    for (unsigned m = 0; m < 12; ++m) {
      const Stats &s = map.agg(e->id).month[m];
      if (!s.messages)
        continue;
      char *p = line;
      *p++ = ',';
      std::memcpy(p, MONTH_LABEL[m], 7);
      p += 7;
      *p++ = '=';
      p = append_uint(p, s.min_len);
      *p++ = '/';
      p = append_average(p, s.total_len, s.messages);
      *p++ = '/';
      p = append_uint(p, s.max_len);
      *p++ = '/';
      p = append_uint(p, s.messages);
      *p++ = '/';
      p = append_uint(p, s.stamps);
      *p++ = '\n';
      buf.append(entry_key(*e), e->len);
      buf.append(line, size_t(p - line));
      if (buf.size() >= (4u << 20)) {
        out.write(buf.data(), buf.size());
        buf.clear();
      }
    }
  out.write(buf.data(), buf.size());
}
int main(int argc, char **argv) {
  std::string input, output;
  unsigned threads = std::max(1u, std::thread::hardware_concurrency());
  bool profiling = false;
  int first_option = 1;
  if (argc == 3 && argv[1][0] != '-' && argv[2][0] != '-') {
    input = argv[1];
    output = argv[2];
    first_option = argc;
  }
  for (int i = first_option; i < argc; ++i) {
    std::string_view a(argv[i]);
    if ((a == "-i" || a == "--input") && i + 1 < argc)
      input = argv[++i];
    else if ((a == "-o" || a == "--output") && i + 1 < argc)
      output = argv[++i];
    else if ((a == "-t" || a == "--threads") && i + 1 < argc) {
      auto v = std::string_view(argv[++i]);
      auto r = std::from_chars(v.data(), v.data() + v.size(), threads);
      if (r.ec != std::errc() || !threads)
        return 1;
    } else if (a == "--profile")
      profiling = true;
    else {
      std::cerr << "unknown or incomplete argument: " << a << "\n";
      return 1;
    }
  }
  if (input.empty()) {
    std::cerr << "optimized C++ analyzer requires -i\n";
    return 1;
  }
  try {
    init_months();
    Profile p;
    auto t = Clock::now();
    MappedFile file(input.c_str());
    if (profiling)
      p.mmap = seconds(t, Clock::now());
    FlatMap map =
        analyze(file.data, file.size, threads, profiling ? &p : nullptr);
    std::ofstream f;
    std::ostream *out = &std::cout;
    if (!output.empty()) {
      f.open(output, std::ios::binary);
      out = &f;
    }
    t = Clock::now();
    write_result(*out, map);
    out->flush();
    if (profiling) {
      p.output = seconds(t, Clock::now());
      std::cerr << "profile mmap=" << p.mmap << " split=" << p.split
                << " workers_wall=" << p.worker_wall
                << " workers_sum=" << p.worker_sum << " merge=" << p.merge
                << " output=" << p.output << " chunks=" << p.chunks
                << " groups=" << p.groups << "\n";
    }
    // ponytail: one-shot CLI; process teardown reclaims mappings and local maps.
    _exit(0);
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  return 0;
}
