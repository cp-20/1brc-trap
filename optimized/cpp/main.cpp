#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

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

using Clock = std::chrono::steady_clock;
static constexpr size_t MAP_CAPACITY = 1u << 15;
static constexpr uint32_t YEAR_START = 1798761600u;
static constexpr uint32_t MONTH_START[] = {
    1798761600u, 1801440000u, 1803859200u, 1806537600u, 1809129600u,
    1811808000u, 1814400000u, 1817078400u, 1819756800u, 1822348800u,
    1825027200u, 1827619200u, 1830297600u};
static constexpr const char *MONTH_LABEL[] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"};

struct Stats {
  uint64_t messages = 0, total_len = 0, stamps = 0;
  uint32_t min_len = 0, max_len = 0;
};
struct ChannelAgg {
  Stats month[12];
};
struct MapEntry {
  const char *key = nullptr;
  uint64_t hash = 0;
  uint32_t len = 0, id = 0;
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
static inline uint64_t rotl(uint64_t x, unsigned n) {
  return (x << n) | (x >> (64 - n));
}
static inline uint64_t mix64(uint64_t x) {
  x ^= x >> 30;
  x *= 0xbf58476d1ce4e5b9ULL;
  x ^= x >> 27;
  x *= 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
static inline uint64_t hash_bytes(const char *p, size_t n) {
  uint64_t a = 0, b = 0, c = 0;
  if (n >= 24) {
    a = load64(p);
    b = load64(p + n / 2 - 4);
    c = load64(p + n - 8);
  } else if (n >= 8) {
    a = load64(p);
    c = load64(p + n - 8);
  } else
    for (size_t i = 0; i < n; ++i)
      a |= uint64_t(uint8_t(p[i])) << (8 * i);
  uint64_t h = a * 0x9e3779b185ebca87ULL ^ rotl(b, 21) ^ rotl(c, 43);
  return mix64(h ^ uint64_t(n) * 0xd6e8feb86659fd93ULL);
}

class FlatMap {
public:
  FlatMap() : entries_(MAP_CAPACITY), aggs_() {
    aggs_.reserve(MAP_CAPACITY / 2);
  }
  void add(const char *key, uint32_t len, uint64_t hash, uint32_t month,
           uint32_t message_len, uint32_t stamps) {
    MapEntry *e = find_or_insert(key, len, hash);
    Stats &s = aggs_[e->id].month[month];
    if (!s.messages) {
      s = Stats{1, message_len, stamps, message_len, message_len};
    } else {
      ++s.messages;
      s.total_len += message_len;
      s.stamps += stamps;
      if (message_len < s.min_len)
        s.min_len = message_len;
      if (message_len > s.max_len)
        s.max_len = message_len;
    }
  }
  void merge_from(const FlatMap &other) {
    for (const MapEntry &src : other.entries_) {
      if (!src.key)
        continue;
      MapEntry *dst = find_or_insert(src.key, src.len, src.hash);
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
  MapEntry *find_or_insert(const char *key, uint32_t len, uint64_t hash) {
    size_t mask = entries_.size() - 1, i = hash & mask;
    for (;;) {
      MapEntry &e = entries_[i];
      if (!e.key) {
        e = MapEntry{key, hash, len, uint32_t(aggs_.size())};
        aggs_.emplace_back();
        ++size_;
        return &e;
      }
      if (e.hash == hash && e.len == len && std::memcmp(e.key, key, len) == 0)
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
static inline uint32_t parse_timestamp(const char *p) {
  uint32_t x = uint8_t(p[0] - '0');
  x = x * 10 + uint8_t(p[1] - '0');
  x = x * 10 + uint8_t(p[2] - '0');
  x = x * 10 + uint8_t(p[3] - '0');
  x = x * 10 + uint8_t(p[4] - '0');
  x = x * 10 + uint8_t(p[5] - '0');
  x = x * 10 + uint8_t(p[6] - '0');
  x = x * 10 + uint8_t(p[7] - '0');
  x = x * 10 + uint8_t(p[8] - '0');
  x = x * 10 + uint8_t(p[9] - '0');
  return x;
}
static FlatMap analyze_chunk(Chunk c) {
  FlatMap map;
  const char *p = c.begin;
  while (p < c.end) {
    if (*p == '\n' || *p == '\r') {
      ++p;
      continue;
    }
    uint32_t ts = parse_timestamp(p);
    uint32_t month = month_by_day[(ts - YEAR_START) / 86400u];
    p += 11;
    const char *key = p;
    while (*p != ',')
      ++p;
    uint32_t len = uint32_t(p - key);
    uint64_t hash = hash_bytes(key, len);
    ++p;
    uint32_t message_len = 0;
    while (*p != ',') {
      message_len = message_len * 10 + uint8_t(*p++ - '0');
    }
    ++p;
    uint32_t stamps = 0;
    while (p < c.end && uint8_t(*p - '0') <= 9)
      stamps = stamps * 10 + uint8_t(*p++ - '0');
    while (p < c.end && *p != '\n')
      ++p;
    if (p < c.end)
      ++p;
    map.add(key, len, hash, month, message_len, stamps);
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
  FlatMap merged;
  for (const auto &m : locals)
    merged.merge_from(m);
  if (prof) {
    prof->merge = seconds(t, Clock::now());
    prof->groups = merged.groups();
  }
  return merged;
}
static void write_result(std::ostream &out, const FlatMap &map) {
  std::vector<const MapEntry *> entries;
  entries.reserve(map.size());
  for (const auto &e : map.entries())
    if (e.key)
      entries.push_back(&e);
  std::sort(entries.begin(), entries.end(), [](auto a, auto b) {
    int c = std::memcmp(a->key, b->key, std::min(a->len, b->len));
    return c < 0 || (c == 0 && a->len < b->len);
  });
  std::string buf;
  buf.reserve(8u << 20);
  char line[160];
  for (auto e : entries)
    for (unsigned m = 0; m < 12; ++m) {
      const Stats &s = map.agg(e->id).month[m];
      if (!s.messages)
        continue;
      int n = std::snprintf(
          line, sizeof(line), ",%s=%u/%.2f/%u/%llu/%llu\n", MONTH_LABEL[m],
          s.min_len, double(s.total_len) / double(s.messages), s.max_len,
          (unsigned long long)s.messages, (unsigned long long)s.stamps);
      buf.append(e->key, e->len);
      buf.append(line, size_t(n));
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
  for (int i = 1; i < argc; ++i) {
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
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  return 0;
}
